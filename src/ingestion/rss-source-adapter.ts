import type { RssSourceAdapterConfig } from '../config';
import type {
	CanonicalItem,
	IngestionBatch,
	IngestionOptions,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';
import { getParser } from '../parsers';
import type { ParsedFeedItem } from '../parsers/types';
import { parseRetryAfter, SourceHttpError } from './source-http-error';

export const RSS_SOURCE_ADAPTER_KEY = 'rss';

export interface RssLoadRequestOptions {
	headers?: HeadersInit;
}

export class RssSourceAdapter implements SourceAdapter<RssSourceAdapterConfig> {
	readonly key = RSS_SOURCE_ADAPTER_KEY;

	decodeConfig(config: unknown): RssSourceAdapterConfig {
		return decodeRssSourceAdapterConfig(config);
	}

	async load(
		source: SourceDefinition<RssSourceAdapterConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		return {
			items: await loadRssCanonicalItems(
				source.config,
				source.identityNamespace,
				context.options,
			),
			itemLimit: context.options.maxItemsPerSource,
			checkpoint: null,
			telemetry: { provider: 'rss' },
		};
	}
}

export function decodeRssSourceAdapterConfig(config: unknown): RssSourceAdapterConfig {
	if (!isRecord(config)) throw new Error('RSS adapter config must be an object');
	const url = requiredString(config.url, 'url');
	assertHttpUrl(url, 'RSS adapter url');
	if (config.parser !== 'it-home' && config.parser !== 'twitter') {
		throw new Error('RSS adapter parser is invalid');
	}
	if (
		config.identityStrategy !== 'external-id'
		&& config.identityStrategy !== 'twitter-status-url'
	) {
		throw new Error('RSS adapter identityStrategy is invalid');
	}

	return {
		url,
		parser: config.parser,
		identityStrategy: config.identityStrategy,
	};
}

export async function loadRssCanonicalItems(
	config: RssSourceAdapterConfig,
	identityNamespace: string,
	options: IngestionOptions,
	requestOptions: RssLoadRequestOptions = {},
): Promise<CanonicalItem[]> {
	const headers = new Headers(requestOptions.headers);
	headers.set('accept', 'application/atom+xml, application/rss+xml, application/xml, text/xml');
	const response = await fetch(config.url, {
		headers,
		signal: AbortSignal.timeout(options.feedTimeoutMs),
	});

	if (!response.ok) {
		const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
		await response.body?.cancel();
		throw new SourceHttpError(
			`RSS fetch failed with HTTP ${response.status}`,
			response.status,
			retryAfterSeconds,
		);
	}

	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > options.maxFeedBytes) {
		await response.body?.cancel();
		throw new Error(`RSS feed exceeds ${options.maxFeedBytes} bytes`);
	}

	const feed = await readBodyWithLimit(response, options.maxFeedBytes);
	const parsed = getParser(config.parser)(feed);
	return Promise.all(parsed.map((item) => normalizeRssItem(
		item,
		identityNamespace,
		config,
	)));
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

async function normalizeRssItem(
	item: ParsedFeedItem,
	identityNamespace: string,
	config: Pick<RssSourceAdapterConfig, 'identityStrategy' | 'parser'>,
): Promise<CanonicalItem> {
	const title = optionalString(item.title);
	const description = optionalString(item.description);
	const formattedDescription = optionalString(item.formattedDescription);
	const rawLink = optionalString(item.link);
	const twitterIdentity = config.identityStrategy === 'twitter-status-url'
		? canonicalTwitterIdentity(rawLink)
		: null;
	const link = twitterIdentity?.link ?? rawLink;
	const publishedAt = parsePublishedAt(item.pubDate);
	const providerId = optionalString(item.guid);
	const externalId = providerId ?? link ?? await fallbackExternalId(identityNamespace, {
		title,
		description,
		publishedAt,
	});

	return {
		externalId,
		identityAliases: config.identityStrategy === 'twitter-status-url'
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
			provider: 'rss',
			parser: config.parser,
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
	identityNamespace: string,
	item: Pick<CanonicalItem, 'description' | 'publishedAt' | 'title'>,
): Promise<string> {
	const value = JSON.stringify([
		identityNamespace,
		item.title,
		item.description,
		item.publishedAt,
	]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`RSS adapter ${name} must not be empty`);
	}
	return value.trim();
}

function assertHttpUrl(value: string, name: string): void {
	try {
		const url = new URL(value);
		if (url.protocol === 'http:' || url.protocol === 'https:') return;
	} catch {
		// Use the same sanitized validation error for malformed and unsupported URLs.
	}
	throw new Error(`${name} must be an HTTP(S) URL`);
}
