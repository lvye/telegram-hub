import type { TwitterApiIoUserAdapterConfig } from '../config';
import type { CanonicalItem, IngestionOptions } from '../domain/ingestion';
import { parseRetryAfter, SourceHttpError } from './source-http-error';

interface TwitterApiIoAuthor {
	id?: unknown;
	name?: unknown;
	userName?: unknown;
}

interface TwitterApiIoTweet {
	author?: TwitterApiIoAuthor | null;
	createdAt?: unknown;
	id?: unknown;
	text?: unknown;
	url?: unknown;
}

interface TwitterApiIoPage {
	has_next_page: boolean;
	next_cursor: string;
	tweets: TwitterApiIoTweet[];
}

export interface TwitterApiIoFetchRequest {
	cursor: string | null;
	minimumPublishedAt: number;
	stopAtExternalId: string | null;
}

export interface TwitterApiIoBatch {
	completed: boolean;
	items: CanonicalItem[];
	newestExternalId: string | null;
	nextCursor: string | null;
	stopReason: 'cutover' | 'end' | 'high-water' | 'page-budget';
}

export class TwitterApiIoError extends SourceHttpError {
	constructor(
		message: string,
		status: number,
		retryAfterSeconds: number | null,
	) {
		super(message, status, retryAfterSeconds);
		this.name = 'TwitterApiIoError';
	}
}

export async function fetchTwitterApiIoBatch(
	source: TwitterApiIoUserAdapterConfig,
	options: IngestionOptions,
	request: TwitterApiIoFetchRequest,
): Promise<TwitterApiIoBatch> {
	const items: CanonicalItem[] = [];
	const startedFromBeginning = request.cursor === null;
	const seenCursors = new Set<string>([request.cursor ?? '']);
	let cursor = request.cursor ?? '';
	let newestExternalId: string | null = null;
	let nextCursor: string | null = null;

	for (let pageNumber = 0; pageNumber < source.maxPages; pageNumber += 1) {
		const page = await fetchPage(source, options, cursor);
		if (startedFromBeginning && pageNumber === 0) {
			const newestTweetId = page.tweets
				.map((tweet) => stringValue(tweet.id))
				.find((tweetId) => tweetId !== null);
			newestExternalId = newestTweetId ? `twitter:${newestTweetId}` : null;
		}

		for (const tweet of page.tweets) {
			const tweetId = stringValue(tweet.id);
			if (tweetId && `twitter:${tweetId}` === request.stopAtExternalId) {
				return {
					completed: true,
					items,
					newestExternalId,
					nextCursor: null,
					stopReason: 'high-water',
				};
			}

			const publishedAt = parsedTweetTime(tweet.createdAt);
			if (publishedAt !== null && publishedAt < request.minimumPublishedAt) {
				return {
					completed: true,
					items,
					newestExternalId,
					nextCursor: null,
					stopReason: 'cutover',
				};
			}

			items.push(...normalizeTweet(tweet, source));
		}

		if (!page.has_next_page) {
			return {
				completed: true,
				items,
				newestExternalId,
				nextCursor: null,
				stopReason: 'end',
			};
		}
		if (!page.next_cursor) {
			throw new Error('TwitterAPI.io indicated another page without a cursor');
		}
		if (seenCursors.has(page.next_cursor)) {
			throw new Error('TwitterAPI.io returned a repeated pagination cursor');
		}

		seenCursors.add(page.next_cursor);
		cursor = page.next_cursor;
		nextCursor = page.next_cursor;
	}

	return {
		completed: false,
		items,
		newestExternalId,
		nextCursor,
		stopReason: 'page-budget',
	};
}

async function fetchPage(
	source: TwitterApiIoUserAdapterConfig,
	options: IngestionOptions,
	cursor: string,
): Promise<TwitterApiIoPage> {
	const url = new URL(source.endpoint);
	if (source.userId) {
		url.searchParams.set('userId', source.userId);
	} else if (source.userName) {
		url.searchParams.set('userName', source.userName);
	} else {
		throw new Error('TwitterAPI.io source requires userId or userName');
	}
	url.searchParams.set('cursor', cursor);
	url.searchParams.set('includeReplies', String(source.includeReplies));

	const response = await fetch(url, {
		headers: {
			accept: 'application/json',
			'X-API-Key': source.apiKey,
		},
		signal: AbortSignal.timeout(options.feedTimeoutMs),
	});
	const body = await readBodyWithLimit(response, options.maxFeedBytes);
	const payload = tryParseJsonObject(body);

	if (!response.ok) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
		throw new TwitterApiIoError(
			`TwitterAPI.io request failed with HTTP ${response.status}${errorSuffix(payload ?? {})}`,
			response.status,
			retryAfterSeconds,
		);
	}
	if (!payload) throw new Error('TwitterAPI.io returned invalid JSON');

	const responseBody = objectValue(payload.data) ?? payload;
	if (payload.status === 'error' || responseBody.status === 'error') {
		throw new TwitterApiIoError(
			`TwitterAPI.io returned an application error${errorSuffix(responseBody) || errorSuffix(payload)}`,
			response.status,
			null,
		);
	}

	if (!Array.isArray(responseBody.tweets)) {
		throw new Error('TwitterAPI.io response is missing tweets');
	}

	return {
		tweets: responseBody.tweets.filter(isObject),
		has_next_page: responseBody.has_next_page === true,
		next_cursor: stringValue(responseBody.next_cursor) ?? '',
	};
}

function normalizeTweet(
	tweet: TwitterApiIoTweet,
	source: TwitterApiIoUserAdapterConfig,
): CanonicalItem[] {
	const id = stringValue(tweet.id);
	if (!id) {
		console.warn({ event: 'twitterapi_io_tweet_skipped', reason: 'missing_id' });
		return [];
	}
	const createdAt = stringValue(tweet.createdAt);
	const publishedAt = parsedTweetTime(createdAt);
	if (publishedAt === null) {
		console.warn({
			event: 'twitterapi_io_tweet_skipped',
			reason: 'invalid_created_at',
			tweetId: id,
		});
		return [];
	}

	const author = objectValue(tweet.author) as TwitterApiIoAuthor | null;
	const userName = normalizedUserName(author?.userName) ?? source.userName;
	const rawLink = validHttpUrl(tweet.url)
		?? (userName
			? `https://x.com/${encodeURIComponent(userName)}/status/${id}`
			: `https://x.com/i/web/status/${id}`);
	const link = canonicalTweetLink(rawLink);
	const externalId = `twitter:${id}`;

	return [{
		externalId,
		identityAliases: [...new Set([externalId, rawLink, link])],
		title: stringValue(tweet.text),
		description: null,
		link,
		author: formatAuthor(author),
		imageUrl: null,
		publishedAt,
		metadata: {
			provider: 'twitterapi-io',
			parser: 'twitter',
		},
	}];
}

function canonicalTweetLink(link: string): string {
	try {
		const url = new URL(link);
		if (!['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(url.hostname)) return link;
		const match = url.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
		return match ? `https://x.com/${match[1]}/status/${match[2]}` : link;
	} catch {
		return link;
	}
}

function formatAuthor(author: TwitterApiIoAuthor | null): string {
	const name = stringValue(author?.name);
	const userName = normalizedUserName(author?.userName);
	if (name && userName) return `${name} (@${userName})`;
	if (userName) return `@${userName}`;
	return name ?? 'Unknown User';
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > maxBytes) {
		await response.body?.cancel();
		throw new Error(`TwitterAPI.io response exceeds ${maxBytes} bytes`);
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
				await reader.cancel('TwitterAPI.io response exceeded the configured byte limit');
				throw new Error(`TwitterAPI.io response exceeds ${maxBytes} bytes`);
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

function tryParseJsonObject(body: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(body);
		if (isObject(value)) return value;
	} catch {
		return null;
	}
	return null;
}

function errorSuffix(value: Record<string, unknown>): string {
	const message = stringValue(value.message)
		?? stringValue(value.msg)
		?? stringValue(value.detail)
		?? stringValue(value.error);
	return message ? `: ${message.slice(0, 300)}` : '';
}

function parsedTweetTime(value: unknown): number | null {
	const raw = stringValue(value);
	if (!raw) return null;
	const timestamp = Date.parse(raw);
	return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null;
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

function objectValue(value: unknown): Record<string, unknown> | null {
	return isObject(value) ? value : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedUserName(value: unknown): string | null {
	return stringValue(value)?.replace(/^@/, '') || null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
