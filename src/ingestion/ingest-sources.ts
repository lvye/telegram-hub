import type {
	AppConfig,
	RssSourceConfig,
	SourceConfig,
	TwitterApiIoSourceConfig,
} from '../config';
import type { ItemInput } from '../domain/delivery';
import { getParser } from '../parsers';
import type { ParsedFeedItem } from '../parsers/types';
import {
	DeliveryRepository,
	type SourceIngestionProgress,
	type SourceIngestionState,
} from '../persistence/delivery-repository';
import {
	TwitterSubscriptionRepository,
	type TwitterSubscription,
} from '../persistence/twitter-subscription-repository';
import {
	fetchTwitterApiIoBatch,
	type TwitterApiIoBatch,
} from './twitterapi-io';

export interface SourceIngestionResult {
	sourceKey: string;
	discovered: number;
}

export async function ingestSources(
	env: Env,
	config: AppConfig,
	scheduledTime = Date.now(),
): Promise<SourceIngestionResult[]> {
	const repository = new DeliveryRepository(env.DB);
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	const sources = await resolveIngestionSources(env.DB, config);
	const dueSources = sources.filter((source) => isSourceDue(source, scheduledTime));
	const results = await Promise.allSettled(
		dueSources.map((source) => ingestSource(source, config, repository, scheduledAt)),
	);
	const failures: unknown[] = [];
	const completed: SourceIngestionResult[] = [];

	for (const result of results) {
		if (result.status === 'fulfilled') {
			completed.push(result.value);
		} else {
			failures.push(result.reason);
		}
	}

	// Recover expired leases before reconciliation so only genuinely active
	// sends can defer a legacy outcome/cursor. This runs every minute; the daily
	// cleanup remains a second safety net for abandoned queued work.
	await repository.recoverStaleDeliveries();

	// Run immediately before dispatch, after the slower feed fetches. This
	// catches legacy claims made during the migration/deploy overlap and can
	// safely block a colliding ready/queued delivery before it is sent.
	await repository.reconcileLegacyRows();

	if (failures.length > 0) {
		throw new AggregateError(failures, `Failed to ingest ${failures.length} source(s)`);
	}

	return completed;
}

async function ingestSource(
	source: SourceConfig,
	config: AppConfig,
	repository: DeliveryRepository,
	scheduledAt: number,
): Promise<SourceIngestionResult> {
	try {
		const providerStateKey = source.type === 'twitterapi-io'
			? twitterApiStateKey(source)
			: null;
		const providerState = source.type === 'twitterapi-io' && providerStateKey
			? await repository.getOrCreateSourceProviderState(
				source.sourceKey,
				providerStateKey,
				source.initializationAt
					?? Math.max(0, scheduledAt - source.pollEveryMinutes * 60),
				60,
				source.bootstrapUserName ?? null,
			)
			: null;
		const loaded = await loadSourceItems(source, config.ingestion, providerState);
		const progress = loaded.apiBatch && providerState
			? nextApiProgress(providerState, loaded.apiBatch)
			: null;
		const normalized = await Promise.all(
			loaded.items.map((item) => normalizeItem(item, source, loaded.provider)),
		);
		const eligibleItems = providerState
			? normalized.filter((item) => (
				item.publishedAt !== null
				&& item.publishedAt >= providerState.initializedAt
			))
			: normalized;
		const uniqueItems = deduplicateItems(eligibleItems);
		const existingIds = await repository.findExistingItemIdentities(
			source.sourceKey,
			uniqueItems,
		);
		const items = uniqueItems
			.filter((item) => !existingIds.has(item.externalId))
			.sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0))
			.slice(
				0,
				loaded.provider === 'twitterapi-io'
					? undefined
					: config.ingestion.maxItemsPerSource,
			);

		await repository.upsertItems(source.sourceKey, source.destinationKey, items);
		if (progress && providerState && providerStateKey) {
			await repository.updateSourceIngestionProgress(
				source.sourceKey,
				providerStateKey,
				providerState,
				progress,
				scheduledAt,
			);
		}

		console.info({
			event: 'source_ingested',
			sourceKey: source.sourceKey,
			provider: loaded.provider,
			discovered: items.length,
			paginationComplete: loaded.apiBatch?.completed,
			paginationStopReason: loaded.apiBatch?.stopReason,
		});
		if (providerState?.lastSuccessfulPollAt === null && loaded.provider === 'twitterapi-io') {
			console.info({
				event: 'source_provider_initialized',
				sourceKey: source.sourceKey,
				provider: loaded.provider,
				historyBoundaryAt: providerState.initializedAt,
				bootstrapHighWater: providerState.highWaterExternalId,
			});
		}

		return { sourceKey: source.sourceKey, discovered: items.length };
	} catch (error) {
		console.error({
			event: 'source_ingestion_failed',
			sourceKey: source.sourceKey,
			error: errorMessage(error),
		});
		throw error;
	}
}

function twitterApiStateKey(source: Extract<SourceConfig, { type: 'twitterapi-io' }>): string {
	if (source.providerStateKey) return source.providerStateKey;
	if (source.userId) return `${source.type}:user-id:${source.userId}`;
	if (source.userName) return `${source.type}:user-name:${source.userName.toLowerCase()}`;
	throw new Error('TwitterAPI.io source requires userId or userName');
}

async function resolveIngestionSources(
	db: D1Database,
	config: AppConfig,
): Promise<SourceConfig[]> {
	const subscriptions = await new TwitterSubscriptionRepository(db).listAll();
	if (subscriptions.length === 0) return config.sources;

	const nonTwitterSources = config.sources.filter((source) => source.messageFormat !== 'twitter');
	const activeSubscriptions = subscriptions.filter((subscription) => subscription.status === 'active');
	if (activeSubscriptions.length === 0) return nonTwitterSources;
	if (!config.twitterApiIo.apiKey) {
		throw new Error('Active Twitter subscriptions require TWITTERAPI_IO_API_KEY');
	}

	const routingSource = config.sources.find((source) => source.messageFormat === 'twitter');
	if (!routingSource) throw new Error('Twitter subscriptions require a Twitter delivery destination');

	return [
		...nonTwitterSources,
		...activeSubscriptions.map((subscription) => subscriptionSource(
			subscription,
			config,
			routingSource,
		)),
	];
}

function subscriptionSource(
	subscription: TwitterSubscription,
	config: AppConfig,
	routingSource: SourceConfig,
): TwitterApiIoSourceConfig {
	return {
		type: 'twitterapi-io',
		sourceKey: 'TWITTER',
		destinationKey: routingSource.destinationKey,
		chatId: routingSource.chatId,
		parseMode: 'HTML',
		messageFormat: 'twitter',
		pollEveryMinutes: subscription.pollEveryMinutes,
		endpoint: config.twitterApiIo.endpoint,
		apiKey: config.twitterApiIo.apiKey!,
		userId: subscription.userId,
		userName: subscription.userName,
		includeReplies: subscription.includeReplies,
		maxPages: subscription.maxPages,
		fallback: null,
		providerStateKey: subscription.providerStateKey,
		initializationAt: subscription.createdAt,
		bootstrapUserName: subscription.userName,
	};
}

interface LoadedSourceItems {
	apiBatch: TwitterApiIoBatch | null;
	items: ParsedFeedItem[];
	provider: 'rss' | 'twitterapi-io';
}

async function loadSourceItems(
	source: SourceConfig,
	options: AppConfig['ingestion'],
	providerState: SourceIngestionState | null,
): Promise<LoadedSourceItems> {
	if (source.type === 'rss') {
		return {
			apiBatch: null,
			items: await fetchRssItems(source.url, source.parser, options),
			provider: 'rss',
		};
	}
	if (!providerState) throw new Error(`Missing provider state for ${source.sourceKey}`);

	try {
		const apiBatch = await fetchTwitterApiIoBatch(source, options, {
			cursor: providerState.nextCursor,
			minimumPublishedAt: providerState.initializedAt,
			stopAtExternalId: providerState.highWaterExternalId,
		});
		return {
			apiBatch,
			items: apiBatch.items,
			provider: 'twitterapi-io',
		};
	} catch (error) {
		if (!source.fallback) throw error;
		console.warn({
			event: 'source_provider_fallback',
			sourceKey: source.sourceKey,
			failedProvider: 'twitterapi-io',
			fallbackProvider: 'rss',
			error: errorMessage(error),
		});
	}

	return {
		apiBatch: null,
		items: await fetchRssItems(source.fallback.url, source.fallback.parser, options),
		provider: 'rss',
	};
}

function nextApiProgress(
	state: SourceIngestionState,
	batch: TwitterApiIoBatch,
): SourceIngestionProgress {
	const pendingHighWater = state.pendingHighWaterExternalId
		?? batch.newestExternalId
		?? state.highWaterExternalId;

	if (!batch.completed) {
		if (!batch.nextCursor || !pendingHighWater) {
			throw new Error('TwitterAPI.io pagination cannot continue without a cursor and high-water');
		}
		return {
			highWaterExternalId: state.highWaterExternalId,
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

async function fetchRssItems(
	url: string,
	parser: RssSourceConfig['parser'],
	options: AppConfig['ingestion'],
): Promise<ParsedFeedItem[]> {
	const feed = await fetchFeed(url, options);
	return getParser(parser)(feed);
}

export function isSourceDue(source: SourceConfig, scheduledTime: number): boolean {
	const minute = Math.floor(scheduledTime / 60_000);
	return minute % source.pollEveryMinutes === 0;
}

function deduplicateItems(items: ItemInput[]): ItemInput[] {
	const unique: ItemInput[] = [];
	const seenAliases = new Set<string>();
	for (const item of items) {
		const aliases = [item.externalId, ...(item.identityAliases ?? [])];
		if (aliases.some((alias) => seenAliases.has(alias))) continue;
		unique.push(item);
		for (const alias of aliases) seenAliases.add(alias);
	}

	return unique;
}

async function fetchFeed(url: string, options: AppConfig['ingestion']): Promise<string> {
	const response = await fetch(url, {
		headers: {
			accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml',
		},
		signal: AbortSignal.timeout(options.feedTimeoutMs),
	});

	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`RSS fetch failed with HTTP ${response.status}`);
	}

	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > options.maxFeedBytes) {
		await response.body?.cancel();
		throw new Error(`RSS feed exceeds ${options.maxFeedBytes} bytes`);
	}

	return readBodyWithLimit(response, options.maxFeedBytes);
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
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
				await reader.cancel('RSS feed exceeded the configured byte limit');
				throw new Error(`RSS feed exceeds ${maxBytes} bytes`);
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

async function normalizeItem(
	item: ParsedFeedItem,
	source: SourceConfig,
	provider: LoadedSourceItems['provider'],
): Promise<ItemInput> {
	const title = optionalString(item.title);
	const description = optionalString(item.description);
	const formattedDescription = optionalString(item.formattedDescription);
	const rawLink = optionalString(item.link);
	const twitterIdentity = source.messageFormat === 'twitter'
		? canonicalTwitterIdentity(rawLink)
		: null;
	const link = twitterIdentity?.link ?? rawLink;
	const publishedAt = parsePublishedAt(item.pubDate);
	const providerId = optionalString(item.guid);
	const explicitId = provider === 'twitterapi-io'
		? twitterIdentity?.externalId ?? providerId ?? link
		: providerId ?? link;
	const externalId = explicitId ?? await fallbackExternalId(source.sourceKey, {
		title,
		description,
		publishedAt,
	});

	return {
		externalId,
		identityAliases: source.messageFormat === 'twitter'
			? [...new Set([
				externalId,
				...(rawLink ? [rawLink] : []),
				...(link ? [link] : []),
				...(twitterIdentity ? [twitterIdentity.externalId] : []),
			])]
			: [externalId],
		title,
		description,
		link,
		author: optionalString(item.author),
		imageUrl: optionalString(item.image),
		publishedAt,
		metadata: {
			provider,
			parser: source.type === 'rss' ? source.parser : 'twitter',
			...(formattedDescription ? {
				descriptionFormat: 'telegram-html-v1',
				telegramHtmlDescription: formattedDescription,
			} : {}),
		},
	};
}

function canonicalTwitterIdentity(link: string | null): { externalId: string; link: string } | null {
	if (!link) return null;
	try {
		const url = new URL(link);
		if (!['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(url.hostname)) return null;
		const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
		if (!match) return null;
		return {
			externalId: `twitter:${match[2]}`,
			link: `https://x.com/${match[1]}/status/${match[2]}`,
		};
	} catch {
		return null;
	}
}

async function fallbackExternalId(
	sourceKey: string,
	item: Pick<ItemInput, 'description' | 'publishedAt' | 'title'>,
): Promise<string> {
	const value = JSON.stringify([sourceKey, item.title, item.description, item.publishedAt]);
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

	return `urn:telegram-hub:sha256:${hex}`;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePublishedAt(value: unknown): number | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
