import type { AppConfig, SourceConfig } from '../config';
import type { ItemInput } from '../domain/delivery';
import { getParser } from '../parsers';
import type { ParsedFeedItem } from '../parsers/types';
import { DeliveryRepository } from '../persistence/delivery-repository';

export interface SourceIngestionResult {
	sourceKey: string;
	discovered: number;
}

export async function ingestSources(env: Env, config: AppConfig): Promise<SourceIngestionResult[]> {
	const repository = new DeliveryRepository(env.DB);
	const results = await Promise.allSettled(
		config.sources.map((source) => ingestSource(source, config, repository)),
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
): Promise<SourceIngestionResult> {
	try {
		const feed = await fetchFeed(source.url, config.ingestion);
		const parse = getParser(source.parser);
		const parsedItems = parse(feed);
		const normalized = await Promise.all(
			parsedItems.map((item) => normalizeItem(item, source)),
		);
		const uniqueItems = deduplicateItems(normalized);
		const existingIds = await repository.findExistingExternalIds(
			source.sourceKey,
			uniqueItems.map((item) => item.externalId),
		);
		const items = uniqueItems
			.filter((item) => !existingIds.has(item.externalId))
			.sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0))
			.slice(0, config.ingestion.maxItemsPerSource);

		await repository.upsertItems(source.sourceKey, source.destinationKey, items);

		console.info({
			event: 'source_ingested',
			sourceKey: source.sourceKey,
			discovered: items.length,
		});

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

function deduplicateItems(items: ItemInput[]): ItemInput[] {
	const unique = new Map<string, ItemInput>();
	for (const item of items) {
		if (!unique.has(item.externalId)) unique.set(item.externalId, item);
	}

	return [...unique.values()];
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

async function normalizeItem(item: ParsedFeedItem, source: SourceConfig): Promise<ItemInput> {
	const title = optionalString(item.title);
	const description = optionalString(item.description);
	const link = optionalString(item.link);
	const publishedAt = parsePublishedAt(item.pubDate);
	const explicitId = optionalString(item.guid) ?? link;
	const externalId = explicitId ?? await fallbackExternalId(source.sourceKey, {
		title,
		description,
		publishedAt,
	});

	return {
		externalId,
		title,
		description,
		link,
		author: optionalString(item.author),
		imageUrl: optionalString(item.image),
		publishedAt,
		metadata: { parser: source.parser },
	};
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
