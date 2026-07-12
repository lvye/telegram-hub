import type { NitterUserAdapterConfig } from '../config';
import type {
	CanonicalItem,
	IngestionBatch,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';
import { loadRssCanonicalItems } from './rss-source-adapter';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointStore,
} from './twitter-api-checkpoint';
import {
	fetchNitterRssOverTls,
	type NitterRssTransport,
} from './nitter-tls-client';

export const NITTER_USER_ADAPTER_KEY = 'nitter.user-timeline';

const NITTER_USER_AGENT = 'Mozilla/5.0 (compatible; TelegramHub/1.0; +https://github.com/lvye/telegram-hub)';

export class NitterUserSourceAdapter implements SourceAdapter<NitterUserAdapterConfig> {
	readonly key = NITTER_USER_ADAPTER_KEY;

	constructor(
		private readonly checkpoints: TwitterApiIoCheckpointStore,
		private readonly transport: NitterRssTransport = fetchNitterRssOverTls,
	) {}

	decodeConfig(config: unknown): NitterUserAdapterConfig {
		return decodeNitterUserAdapterConfig(config);
	}

	async load(
		source: SourceDefinition<NitterUserAdapterConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		const checkpoint = await this.checkpoints.getOrCreate({
			identityNamespace: source.identityNamespace,
			checkpointKey: source.config.providerStateKey,
			fallbackInitializedAt: source.config.initializationAt,
			overlapSeconds: 60,
			bootstrapUserName: source.config.userName,
		});
		const loaded = await loadRssCanonicalItems({
			url: source.config.feedUrl,
			parser: 'twitter',
			identityStrategy: 'twitter-status-url',
		}, source.identityNamespace, context.options, {
			fetchImpl: (input, init) => this.transport(
				input,
				init,
				context.options.feedTimeoutMs,
				context.options.maxFeedBytes,
			),
			headers: {
				'user-agent': NITTER_USER_AGENT,
			},
		});
		const normalized = loaded.map((item) => normalizeNitterItem(item, source.config.userName));
		const progress: TwitterApiIoCheckpointProgress = {
			highWaterExternalId: newestHighWater(normalized, checkpoint),
			nextCursor: null,
			pendingHighWaterExternalId: null,
		};

		return {
			items: normalized.filter((item) => (
				item.publishedAt !== null
				&& item.publishedAt >= checkpoint.initializedAt
				&& (source.config.includeReplies || !isNitterReply(item.title))
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
				provider: 'nitter',
				...(checkpoint.lastSuccessfulPollAt === null
					? {
						initialization: {
							historyBoundaryAt: checkpoint.initializedAt,
							bootstrapHighWater: checkpoint.highWaterExternalId,
						},
					}
					: {}),
			},
		};
	}
}

export function decodeNitterUserAdapterConfig(config: unknown): NitterUserAdapterConfig {
	if (!isRecord(config)) throw new Error('Nitter adapter config must be an object');
	const feedUrl = requiredString(config.feedUrl, 'feedUrl');
	assertHttpUrl(feedUrl, 'Nitter adapter feedUrl');
	const userName = requiredString(config.userName, 'userName').replace(/^@/u, '');
	if (!userName || userName.includes('/')) {
		throw new Error('Nitter adapter userName must be a Twitter handle');
	}
	if (typeof config.includeReplies !== 'boolean') {
		throw new Error('Nitter adapter includeReplies must be boolean');
	}
	const providerStateKey = requiredString(config.providerStateKey, 'providerStateKey');
	if (
		typeof config.initializationAt !== 'number'
		|| !Number.isInteger(config.initializationAt)
		|| config.initializationAt < 0
	) {
		throw new Error('Nitter adapter initializationAt must be a non-negative integer');
	}

	return {
		feedUrl,
		userName,
		includeReplies: config.includeReplies,
		providerStateKey,
		initializationAt: config.initializationAt,
	};
}

function normalizeNitterItem(item: CanonicalItem, userName: string): CanonicalItem {
	const statusId = nitterStatusId(item);
	if (!statusId) return {
		...item,
		metadata: { ...item.metadata, provider: 'nitter' },
	};

	const rawLink = item.link;
	const link = `https://x.com/${encodeURIComponent(userName)}/status/${statusId}`;
	const externalId = `twitter:${statusId}`;
	return {
		...item,
		identityAliases: [...new Set([
			item.externalId,
			...(item.identityAliases ?? []),
			...(rawLink ? [rawLink] : []),
			link,
			externalId,
		])],
		link,
		metadata: { ...item.metadata, provider: 'nitter' },
	};
}

function nitterStatusId(item: CanonicalItem): string | null {
	if (item.link) {
		try {
			const match = new URL(item.link).pathname.match(/\/status\/(\d+)/u);
			if (match) return match[1];
		} catch {
			// Fall through to the provider GUID.
		}
	}
	return /^\d+$/u.test(item.externalId) ? item.externalId : null;
}

function newestHighWater(
	items: CanonicalItem[],
	checkpoint: TwitterApiIoCheckpoint,
): string | null {
	const candidates = [
		checkpoint.highWaterExternalId,
		...items.flatMap((item) => (item.identityAliases ?? []).filter((alias) => (
			/^twitter:\d+$/u.test(alias)
		))),
	].filter((value): value is string => value !== null);
	return candidates.reduce<string | null>((newest, candidate) => {
		if (!newest) return candidate;
		return tweetId(candidate) > tweetId(newest) ? candidate : newest;
	}, null);
}

function tweetId(identity: string): bigint {
	const value = identity.replace(/^twitter:/u, '');
	return /^\d+$/u.test(value) ? BigInt(value) : 0n;
}

function isNitterReply(title: string | null): boolean {
	return /^R to @[^:]+:/u.test(title ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Nitter adapter ${name} must not be empty`);
	}
	return value.trim();
}

function assertHttpUrl(value: string, name: string): void {
	try {
		const url = new URL(value);
		if (url.protocol === 'https:' || url.protocol === 'http:') return;
	} catch {
		// Use the common validation error below.
	}
	throw new Error(`${name} must be an HTTP URL`);
}
