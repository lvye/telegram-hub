import { parseDocument } from 'htmlparser2';
import { hasChildren, isTag, type ChildNode } from 'domhandler';
import type {
	TwitterApiIoSearchAdapterConfig,
	TwitterApiIoUserAdapterConfig,
} from '../config';
import type { CanonicalItem, IngestionOptions } from '../domain/ingestion';
import { parseRetryAfter, SourceHttpError } from './source-http-error';

interface TwitterApiIoAuthor {
	id?: unknown;
	name?: unknown;
	userName?: unknown;
}

export interface TwitterApiIoTweet {
	author?: TwitterApiIoAuthor | null;
	createdAt?: unknown;
	entities?: unknown;
	extended_entities?: unknown;
	extendedEntities?: unknown;
	id?: unknown;
	isReply?: unknown;
	media?: unknown;
	text?: unknown;
	url?: unknown;
}

interface TweetPhoto {
	imageUrl: string;
	shortUrls: string[];
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

export interface TwitterApiIoSearchRequest {
	cursor: string | null;
	minimumPublishedAt: number;
	scheduledAt: number;
}

export interface TwitterApiIoSearchBatch {
	completed: boolean;
	items: CanonicalItem[];
	newestExternalId: string | null;
	nextCursor: string | null;
	requestCount: number;
	resourceCount: number;
	billableUnitCount: number;
	stopReason: 'end' | 'page-budget';
}

interface TwitterApiIoSearchCursor {
	endAt: number;
	startAt: number;
	token: string;
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

			items.push(...await normalizeTweet(tweet, source.userName, options));
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

export async function fetchTwitterApiIoSearchBatch(
	source: TwitterApiIoSearchAdapterConfig,
	options: IngestionOptions,
	request: TwitterApiIoSearchRequest,
): Promise<TwitterApiIoSearchBatch> {
	const continuation = decodeSearchCursor(request.cursor);
	const startAt = continuation?.startAt ?? request.minimumPublishedAt;
	const endAt = continuation?.endAt ?? Math.max(startAt + 1, request.scheduledAt);
	let cursor = continuation?.token ?? '';
	let requestCount = 0;
	let resourceCount = 0;
	let billableUnitCount = 0;
	const newestExternalId = request.cursor === null
		? `twitter-search-time:${endAt}`
		: null;
	const items: CanonicalItem[] = [];
	const seenCursors = new Set<string>([cursor]);

	for (let pageNumber = 0; pageNumber < source.maxPages; pageNumber += 1) {
		const page = await fetchSearchPage(source, options, cursor, startAt, endAt);
		requestCount += 1;
		resourceCount += page.tweets.length;
		billableUnitCount += Math.max(1, page.tweets.length);
		for (const tweet of page.tweets) {
			if (!tweetMatchesSearchSource(tweet, source)) continue;
			items.push(...await normalizeTweet(tweet, null, options));
		}

		if (!page.has_next_page) {
			return {
				completed: true,
				items,
				newestExternalId,
				nextCursor: null,
				requestCount,
				resourceCount,
				billableUnitCount,
				stopReason: 'end',
			};
		}
		if (!page.next_cursor) {
			throw new Error('TwitterAPI.io search indicated another page without a cursor');
		}
		if (seenCursors.has(page.next_cursor)) {
			throw new Error('TwitterAPI.io search returned a repeated pagination cursor');
		}
		seenCursors.add(page.next_cursor);
		cursor = page.next_cursor;
	}

	return {
		completed: false,
		items,
		newestExternalId,
		nextCursor: encodeSearchCursor({ endAt, startAt, token: cursor }),
		requestCount,
		resourceCount,
		billableUnitCount,
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

async function fetchSearchPage(
	source: TwitterApiIoSearchAdapterConfig,
	options: IngestionOptions,
	cursor: string,
	startAt: number,
	endAt: number,
): Promise<TwitterApiIoPage> {
	const url = new URL(source.endpoint);
	url.searchParams.set('query', twitterApiIoSearchQuery(source, startAt, endAt));
	url.searchParams.set('queryType', 'Latest');
	url.searchParams.set('cursor', cursor);

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
			`TwitterAPI.io search failed with HTTP ${response.status}${errorSuffix(payload ?? {})}`,
			response.status,
			retryAfterSeconds,
		);
	}
	if (!payload) throw new Error('TwitterAPI.io search returned invalid JSON');
	const responseBody = objectValue(payload.data) ?? payload;
	if (payload.status === 'error' || responseBody.status === 'error') {
		throw new TwitterApiIoError(
			`TwitterAPI.io search returned an application error${errorSuffix(responseBody) || errorSuffix(payload)}`,
			response.status,
			null,
		);
	}
	if (!Array.isArray(responseBody.tweets)) {
		throw new Error('TwitterAPI.io search response is missing tweets');
	}
	return {
		tweets: responseBody.tweets.filter(isObject),
		has_next_page: responseBody.has_next_page === true,
		next_cursor: stringValue(responseBody.next_cursor) ?? '',
	};
}

async function normalizeTweet(
	tweet: TwitterApiIoTweet,
	fallbackUserName: string | null,
	options: IngestionOptions,
): Promise<CanonicalItem[]> {
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
	const userName = normalizedUserName(author?.userName) ?? fallbackUserName;
	const rawLink = validHttpUrl(tweet.url)
		?? (userName
			? `https://x.com/${encodeURIComponent(userName)}/status/${id}`
			: `https://x.com/i/web/status/${id}`);
	const link = canonicalTweetLink(rawLink);
	const externalId = `twitter:${id}`;
	const photo = extractTweetPhoto(tweet)
		?? await fetchTweetPhotoPage(tweet, id, options);
	const text = stringValue(tweet.text);

	return [{
		externalId,
		identityAliases: [...new Set([externalId, rawLink, link])],
		title: photo ? withoutMediaShortUrls(text, photo.shortUrls) : text,
		description: null,
		link,
		author: formatAuthor(author),
		imageUrl: photo?.imageUrl ?? null,
		publishedAt,
		metadata: {
			provider: 'twitterapi-io',
			parser: 'twitter',
		},
	}];
}

function twitterApiIoSearchQuery(
	source: TwitterApiIoSearchAdapterConfig,
	startAt: number,
	endAt: number,
): string {
	const accounts = source.handles.map((handle) => `from:${handle}`).join(' OR ');
	return [
		`(${accounts})`,
		source.includeReplies ? '' : '-filter:replies',
		`since_time:${Math.max(0, startAt)}`,
		`until_time:${Math.max(startAt + 1, endAt)}`,
	].filter(Boolean).join(' ');
}

function tweetMatchesSearchSource(
	tweet: TwitterApiIoTweet,
	source: TwitterApiIoSearchAdapterConfig,
): boolean {
	const author = objectValue(tweet.author) as TwitterApiIoAuthor | null;
	const userName = normalizedUserName(author?.userName)?.toLowerCase();
	if (!userName || !source.handles.some((handle) => handle.toLowerCase() === userName)) {
		return false;
	}
	return source.includeReplies || tweet.isReply !== true;
}

function encodeSearchCursor(cursor: TwitterApiIoSearchCursor): string {
	return JSON.stringify(cursor);
}

function decodeSearchCursor(value: string | null): TwitterApiIoSearchCursor | null {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isObject(parsed)) throw new Error('not an object');
		const token = stringValue(parsed.token);
		const startAt = nonNegativeInteger(parsed.startAt);
		const endAt = nonNegativeInteger(parsed.endAt);
		if (!token || startAt === null || endAt === null || endAt <= startAt) {
			throw new Error('invalid fields');
		}
		return { endAt, startAt, token };
	} catch (error) {
		throw new Error('TwitterAPI.io search checkpoint cursor is invalid', { cause: error });
	}
}

async function fetchTweetPhotoPage(
	tweet: TwitterApiIoTweet,
	tweetId: string,
	options: IngestionOptions,
): Promise<TweetPhoto | null> {
	for (const entity of objectList(objectValue(tweet.entities)?.urls)) {
		const pageUrl = twitterPhotoPageUrl(
			entity.expanded_url,
			entity.expandedUrl,
			entity.unwound_url,
			entity.unwoundUrl,
		);
		if (!pageUrl) continue;

		try {
			const response = await fetch(pageUrl, {
				headers: { accept: 'text/html,application/xhtml+xml' },
				redirect: 'follow',
				signal: AbortSignal.timeout(options.feedTimeoutMs),
			});
			if (!response.ok) {
				await response.body?.cancel();
				console.warn({
					event: 'twitter_photo_page_unavailable',
					tweetId,
					status: response.status,
				});
				continue;
			}

			const html = await readBodyWithLimit(response, options.maxFeedBytes);
			const imageUrl = openGraphTweetImage(html);
			if (!imageUrl) continue;

			return {
				imageUrl,
				shortUrls: [stringValue(entity.url)].filter((value): value is string => value !== null),
			};
		} catch (error) {
			console.warn({
				event: 'twitter_photo_page_unavailable',
				tweetId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return null;
}

function twitterPhotoPageUrl(...values: unknown[]): string | null {
	for (const value of values) {
		const raw = validHttpUrl(value);
		if (!raw) continue;
		const url = new URL(raw);
		const host = url.hostname.toLowerCase();
		if (!['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(host)) continue;
		if (!/^\/[^/]+\/status\/\d+\/photo\/\d+\/?$/u.test(url.pathname)) continue;
		return url.toString();
	}
	return null;
}

function openGraphTweetImage(html: string): string | null {
	const document = parseDocument(html, {
		decodeEntities: true,
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		xmlMode: false,
	});
	return findOpenGraphTweetImage(document.children);
}

function findOpenGraphTweetImage(nodes: ChildNode[]): string | null {
	for (const node of nodes) {
		if (isTag(node) && node.name === 'meta') {
			const property = (node.attribs.property ?? node.attribs.name ?? '').toLowerCase();
			if (property === 'og:image' || property === 'twitter:image') {
				const imageUrl = twitterMediaImageUrl(node.attribs.content);
				if (imageUrl) return imageUrl;
			}
		}
		if (hasChildren(node)) {
			const imageUrl = findOpenGraphTweetImage(node.children);
			if (imageUrl) return imageUrl;
		}
	}
	return null;
}

function twitterMediaImageUrl(value: unknown): string | null {
	const raw = validHttpUrl(value);
	if (!raw) return null;
	const url = new URL(raw);
	if (url.hostname.toLowerCase() !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) {
		return null;
	}
	url.protocol = 'https:';
	return url.toString();
}

function extractTweetPhoto(tweet: TwitterApiIoTweet): TweetPhoto | null {
	const mediaContainers = [
		objectValue(tweet.extendedEntities)?.media,
		objectValue(tweet.extended_entities)?.media,
		objectValue(tweet.entities)?.media,
		tweet.media,
	];

	for (const container of mediaContainers) {
		for (const media of objectList(container)) {
			const mediaType = stringValue(media.type)?.toLowerCase();
			if (mediaType && mediaType !== 'photo') continue;

			const imageUrl = normalizeMediaUrl(
				media.media_url_https,
				media.mediaUrlHttps,
				media.media_url,
				media.mediaUrl,
			);
			if (!imageUrl) continue;

			return {
				imageUrl,
				shortUrls: [stringValue(media.url)].filter((value): value is string => value !== null),
			};
		}
	}

	// Some payload variants expose a direct image through the documented URL entities
	// instead of an extended media collection.
	for (const entity of objectList(objectValue(tweet.entities)?.urls)) {
		const imageUrl = directImageUrl(
			entity.expanded_url,
			entity.expandedUrl,
			entity.unwound_url,
			entity.unwoundUrl,
		);
		if (!imageUrl) continue;
		return {
			imageUrl,
			shortUrls: [stringValue(entity.url)].filter((value): value is string => value !== null),
		};
	}

	return null;
}

function withoutMediaShortUrls(text: string | null, shortUrls: string[]): string | null {
	if (!text) return null;

	let result = text;
	for (const shortUrl of new Set(shortUrls)) {
		if (!isTwitterShortUrl(shortUrl)) continue;
		result = result.replaceAll(shortUrl, '');
	}

	const cleaned = result
		.replace(/[ \t]+\n/gu, '\n')
		.replace(/\n[ \t]+/gu, '\n')
		.replace(/[ \t]{2,}/gu, ' ')
		.replace(/\n{3,}/gu, '\n\n')
		.trim();
	return cleaned || text;
}

function normalizeMediaUrl(...values: unknown[]): string | null {
	for (const value of values) {
		const raw = validHttpUrl(value);
		if (!raw) continue;
		const url = new URL(raw);
		if (url.hostname.toLowerCase() === 'pbs.twimg.com') url.protocol = 'https:';
		return url.toString();
	}
	return null;
}

function directImageUrl(...values: unknown[]): string | null {
	for (const value of values) {
		const raw = validHttpUrl(value);
		if (!raw) continue;
		const url = new URL(raw);
		const host = url.hostname.toLowerCase();
		const format = url.searchParams.get('format')?.toLowerCase();
		const hasImageExtension = /\.(?:gif|jpe?g|png|webp)$/iu.test(url.pathname);
		const hasImageFormat = format ? ['gif', 'jpeg', 'jpg', 'png', 'webp'].includes(format) : false;
		if ((host === 'pbs.twimg.com' && url.pathname.startsWith('/media/')) || hasImageExtension || hasImageFormat) {
			if (host === 'pbs.twimg.com') url.protocol = 'https:';
			return url.toString();
		}
	}
	return null;
}

function isTwitterShortUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' && url.hostname.toLowerCase() === 't.co';
	} catch {
		return false;
	}
}

function objectList(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value.filter(isObject);
	const object = objectValue(value);
	return object ? [object] : [];
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

function nonNegativeInteger(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function normalizedUserName(value: unknown): string | null {
	return stringValue(value)?.replace(/^@/, '') || null;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
