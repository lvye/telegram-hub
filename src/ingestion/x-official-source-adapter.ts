import type { XOfficialUserAdapterConfig } from '../config';
import type {
	CanonicalItem,
	IngestionBatch,
	IngestionOptions,
	ProviderUsage,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';
import type {
	SourceProviderMetadataStore,
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointStore,
} from './twitter-api-checkpoint';
import { parseRetryAfter, SourceHttpError } from './source-http-error';

export const X_OFFICIAL_USER_ADAPTER_KEY = 'x.user-timeline';
const X_POST_READ_USD_MICROS = 5_000;
const X_USER_READ_USD_MICROS = 10_000;

interface XOfficialPost {
	attachments?: unknown;
	created_at?: unknown;
	id?: unknown;
	note_tweet?: unknown;
	text?: unknown;
}

interface XOfficialBatch {
	completed: boolean;
	items: CanonicalItem[];
	newestExternalId: string | null;
	nextCursor: string | null;
	requestCount: number;
	resourceCount: number;
	stopReason: 'end' | 'page-budget';
}

export class XOfficialApiError extends SourceHttpError {
	constructor(message: string, status: number, retryAfterSeconds: number | null) {
		super(message, status, retryAfterSeconds);
		this.name = 'XOfficialApiError';
	}
}

export class XOfficialUserSourceAdapter implements SourceAdapter<XOfficialUserAdapterConfig> {
	readonly key = X_OFFICIAL_USER_ADAPTER_KEY;

	constructor(
		private readonly checkpoints: TwitterApiIoCheckpointStore,
		private readonly metadata: SourceProviderMetadataStore,
		private readonly resolveUserId: typeof fetchXOfficialUserId = fetchXOfficialUserId,
		private readonly fetchBatch: typeof fetchXOfficialBatch = fetchXOfficialBatch,
	) {}

	decodeConfig(config: unknown): XOfficialUserAdapterConfig {
		return decodeXOfficialUserAdapterConfig(config);
	}

	async load(
		source: SourceDefinition<XOfficialUserAdapterConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		const checkpoint = await this.checkpoints.getOrCreate({
			identityNamespace: source.identityNamespace,
			checkpointKey: source.config.providerStateKey,
			fallbackInitializedAt: source.config.initializationAt,
			overlapSeconds: 60,
			bootstrapUserName: source.config.userName,
		});
		const metadata = await this.metadata.getMetadata(source.sourceId);
		let userId = source.config.userId ?? optionalString(metadata.xOfficialUserId);
		const usage: ProviderUsage[] = [];
		if (!userId) {
			userId = await this.resolveUserId(source.config, context.options);
			await this.metadata.mergeMetadata(
				source.sourceId,
				{ xOfficialUserId: userId },
				context.scheduledAt,
			);
			usage.push({
				operationKey: 'user.lookup.read',
				providerKey: 'x',
				requestCount: 1,
				resourceCount: 1,
				billableUnitCount: 1,
				unitPriceUsdMicros: X_USER_READ_USD_MICROS,
			});
		}

		const apiBatch = await this.fetchBatch(source.config, userId, context.options, {
			cursor: checkpoint.nextCursor,
			sinceExternalId: checkpoint.highWaterExternalId,
		});
		usage.push({
			operationKey: 'post.timeline.read',
			providerKey: 'x',
			requestCount: apiBatch.requestCount,
			resourceCount: apiBatch.resourceCount,
			billableUnitCount: apiBatch.resourceCount,
			unitPriceUsdMicros: X_POST_READ_USD_MICROS,
		});
		const progress = nextXProgress(checkpoint, apiBatch);

		return {
			items: apiBatch.items.filter((item) => (
				item.publishedAt !== null && item.publishedAt >= checkpoint.initializedAt
			)),
			itemLimit: context.options.maxItemsPerSource,
			checkpoint: {
				commit: (updatedAt) => this.checkpoints.commit(
					source.identityNamespace,
					source.config.providerStateKey,
					checkpoint,
					progress,
					updatedAt,
				),
			},
			telemetry: {
				provider: 'x',
				paginationComplete: apiBatch.completed,
				paginationStopReason: apiBatch.stopReason,
				usage,
				...(checkpoint.lastSuccessfulPollAt === null ? {
					initialization: {
						historyBoundaryAt: checkpoint.initializedAt,
						userName: source.config.userName,
					},
				} : {}),
			},
		};
	}
}

export function decodeXOfficialUserAdapterConfig(config: unknown): XOfficialUserAdapterConfig {
	if (!isRecord(config)) throw new Error('X official adapter config must be an object');
	const endpoint = requiredString(config.endpoint, 'endpoint');
	assertHttpsUrl(endpoint);
	const userName = twitterHandle(config.userName);
	if (typeof config.includeReplies !== 'boolean') {
		throw new Error('X official adapter includeReplies must be boolean');
	}
	return {
		bearerToken: requiredString(config.bearerToken, 'bearerToken'),
		endpoint,
		includeReplies: config.includeReplies,
		initializationAt: boundedInteger(
			config.initializationAt,
			'initializationAt',
			0,
			Number.MAX_SAFE_INTEGER,
		),
		maxPages: boundedInteger(config.maxPages, 'maxPages', 1, 5),
		providerStateKey: requiredString(config.providerStateKey, 'providerStateKey'),
		userId: optionalString(config.userId),
		userName,
	};
}

export async function fetchXOfficialUserId(
	source: XOfficialUserAdapterConfig,
	options: IngestionOptions,
): Promise<string> {
	const url = xApiUrl(source.endpoint, `users/by/username/${encodeURIComponent(source.userName)}`);
	const payload = await fetchXJson(url, source.bearerToken, options);
	const data = objectValue(payload.data);
	const userId = stringValue(data?.id);
	if (!userId) throw new Error(`X user lookup returned no ID for @${source.userName}`);
	return userId;
}

export async function fetchXOfficialBatch(
	source: XOfficialUserAdapterConfig,
	userId: string,
	options: IngestionOptions,
	request: { cursor: string | null; sinceExternalId: string | null },
): Promise<XOfficialBatch> {
	const items: CanonicalItem[] = [];
	const media = new Map<string, string>();
	const sinceId = twitterStatusId(request.sinceExternalId);
	let cursor = request.cursor;
	let newestExternalId: string | null = null;
	let requestCount = 0;
	let resourceCount = 0;

	for (let pageNumber = 0; pageNumber < source.maxPages; pageNumber += 1) {
		const url = xApiUrl(source.endpoint, `users/${encodeURIComponent(userId)}/tweets`);
		url.searchParams.set('max_results', '100');
		url.searchParams.set('tweet.fields', 'attachments,created_at,note_tweet');
		url.searchParams.set('expansions', 'attachments.media_keys');
		url.searchParams.set('media.fields', 'media_key,preview_image_url,type,url');
		if (!source.includeReplies) url.searchParams.set('exclude', 'replies');
		if (sinceId) url.searchParams.set('since_id', sinceId);
		if (cursor) url.searchParams.set('pagination_token', cursor);

		const payload = await fetchXJson(url, source.bearerToken, options);
		const posts = Array.isArray(payload.data) ? payload.data.filter(isRecord) : [];
		requestCount += 1;
		resourceCount += posts.length;
		for (const entry of objectList(objectValue(payload.includes)?.media)) {
			const key = stringValue(entry.media_key);
			const imageUrl = validHttpUrl(entry.url) ?? validHttpUrl(entry.preview_image_url);
			if (key && imageUrl) media.set(key, imageUrl);
		}
		if (pageNumber === 0 && request.cursor === null) {
			const newestId = posts.map((post) => stringValue(post.id)).find(Boolean);
			newestExternalId = newestId ? `twitter:${newestId}` : null;
		}
		items.push(...posts.flatMap((post) => normalizeXPost(post, source.userName, media)));

		const nextToken = stringValue(objectValue(payload.meta)?.next_token);
		if (!nextToken) {
			return {
				completed: true,
				items,
				newestExternalId,
				nextCursor: null,
				requestCount,
				resourceCount,
				stopReason: 'end',
			};
		}
		if (nextToken === cursor) throw new Error('X timeline returned a repeated pagination token');
		cursor = nextToken;
	}

	return {
		completed: false,
		items,
		newestExternalId,
		nextCursor: cursor,
		requestCount,
		resourceCount,
		stopReason: 'page-budget',
	};
}

function normalizeXPost(
	post: XOfficialPost,
	userName: string,
	media: Map<string, string>,
): CanonicalItem[] {
	const id = stringValue(post.id);
	const createdAt = stringValue(post.created_at);
	const timestamp = createdAt ? Date.parse(createdAt) : Number.NaN;
	if (!id || !Number.isFinite(timestamp)) return [];
	const externalId = `twitter:${id}`;
	const link = `https://x.com/${encodeURIComponent(userName)}/status/${id}`;
	const mediaKeys = objectValue(post.attachments)?.media_keys;
	const imageUrl = Array.isArray(mediaKeys)
		? mediaKeys.map((key) => typeof key === 'string' ? media.get(key) : null).find(Boolean) ?? null
		: null;
	const noteText = stringValue(objectValue(post.note_tweet)?.text);
	return [{
		externalId,
		identityAliases: [externalId, link],
		title: noteText ?? stringValue(post.text),
		description: null,
		link,
		author: `@${userName}`,
		imageUrl,
		publishedAt: Math.floor(timestamp / 1_000),
		metadata: { parser: 'twitter', provider: 'x' },
	}];
}

async function fetchXJson(
	url: URL,
	bearerToken: string,
	options: IngestionOptions,
): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		headers: { accept: 'application/json', authorization: `Bearer ${bearerToken}` },
		signal: AbortSignal.timeout(options.feedTimeoutMs),
	});
	const body = await readBodyWithLimit(response, options.maxFeedBytes);
	const payload = jsonObject(body);
	if (!response.ok) {
		throw new XOfficialApiError(
			`X API request failed with HTTP ${response.status}${errorSuffix(payload)}`,
			response.status,
			parseRetryAfter(response.headers.get('retry-after')),
		);
	}
	if (!payload) throw new Error('X API returned invalid JSON');
	if (!payload.data && Array.isArray(payload.errors) && payload.errors.length > 0) {
		throw new Error(`X API returned an application error${errorSuffix(payload)}`);
	}
	return payload;
}

function nextXProgress(
	checkpoint: TwitterApiIoCheckpoint,
	batch: XOfficialBatch,
): TwitterApiIoCheckpointProgress {
	const pendingHighWater = checkpoint.pendingHighWaterExternalId
		?? batch.newestExternalId
		?? checkpoint.highWaterExternalId;
	if (!batch.completed) {
		if (!batch.nextCursor || !pendingHighWater) {
			throw new Error('X timeline pagination cannot continue without state');
		}
		return {
			highWaterExternalId: checkpoint.highWaterExternalId,
			nextCursor: batch.nextCursor,
			pendingHighWaterExternalId: pendingHighWater,
		};
	}
	return {
		highWaterExternalId: pendingHighWater,
		nextCursor: null,
		pendingHighWaterExternalId: null,
	};
}

function xApiUrl(endpoint: string, path: string): URL {
	const base = new URL(endpoint);
	if (!base.pathname.endsWith('/')) base.pathname += '/';
	return new URL(path, base);
}

function twitterStatusId(value: string | null): string | null {
	return value?.match(/^twitter:(\d+)$/u)?.[1] ?? null;
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`X API response exceeds ${maxBytes} bytes`);
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel('X API response exceeded the configured byte limit');
				throw new Error(`X API response exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function jsonObject(value: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function errorSuffix(value: Record<string, unknown> | null): string {
	if (!value) return '';
	const direct = stringValue(value.detail) ?? stringValue(value.title) ?? stringValue(value.message);
	if (direct) return `: ${direct.slice(0, 300)}`;
	const firstError = Array.isArray(value.errors) ? objectValue(value.errors[0]) : null;
	const nested = stringValue(firstError?.detail) ?? stringValue(firstError?.title);
	return nested ? `: ${nested.slice(0, 300)}` : '';
}

function validHttpUrl(value: unknown): string | null {
	const raw = stringValue(value);
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function objectList(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function twitterHandle(value: unknown): string {
	const handle = requiredString(value, 'userName').replace(/^@/u, '');
	if (!/^[A-Za-z0-9_]{1,15}$/u.test(handle)) {
		throw new Error(`X official adapter userName is invalid: ${handle}`);
	}
	return handle;
}

function boundedInteger(
	value: unknown,
	name: string,
	minimum: number,
	maximum: number,
): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new Error(`X official adapter ${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`X official adapter ${name} must not be empty`);
	}
	return value.trim();
}

function assertHttpsUrl(value: string): void {
	try {
		if (new URL(value).protocol === 'https:') return;
	} catch {
		// Use one sanitized error for malformed and non-HTTPS URLs.
	}
	throw new Error('X official adapter endpoint must be an HTTPS URL');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
