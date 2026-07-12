import type { TwitterApiIoUserAdapterConfig } from '../config';
import type {
	IngestionBatch,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';
import {
	decodeRssSourceAdapterConfig,
	loadRssCanonicalItems,
} from './rss-source-adapter';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointStore,
} from './twitter-api-checkpoint';
import { fetchTwitterApiIoBatch, type TwitterApiIoBatch } from './twitterapi-io';

export const TWITTER_API_IO_USER_ADAPTER_KEY = 'twitterapi-io.user-timeline';

export class TwitterApiIoUserSourceAdapter implements SourceAdapter<TwitterApiIoUserAdapterConfig> {
	readonly key = TWITTER_API_IO_USER_ADAPTER_KEY;

	constructor(
		private readonly checkpoints: TwitterApiIoCheckpointStore,
		private readonly fetchBatch: typeof fetchTwitterApiIoBatch = fetchTwitterApiIoBatch,
	) {}

	decodeConfig(config: unknown): TwitterApiIoUserAdapterConfig {
		return decodeTwitterApiIoUserAdapterConfig(config);
	}

	async load(
		source: SourceDefinition<TwitterApiIoUserAdapterConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		const checkpointKey = twitterApiStateKey(source.config);
		const checkpoint = await this.checkpoints.getOrCreate({
			identityNamespace: source.identityNamespace,
			checkpointKey,
			fallbackInitializedAt: source.config.initializationAt
				?? Math.max(0, context.scheduledAt - source.pollEveryMinutes * 60),
			overlapSeconds: 60,
			bootstrapUserName: source.config.bootstrapUserName ?? null,
		});

		try {
			const apiBatch = await this.fetchBatch(source.config, context.options, {
				cursor: checkpoint.nextCursor,
				minimumPublishedAt: checkpoint.initializedAt,
				stopAtExternalId: checkpoint.highWaterExternalId,
			});
			const progress = nextApiProgress(checkpoint, apiBatch);

			return {
				items: eligibleItems(apiBatch.items, checkpoint),
				itemLimit: context.options.maxItemsPerSource,
				checkpoint: {
					commit: (updatedAt) => this.checkpoints.commit(
						source.identityNamespace,
						checkpointKey,
						checkpoint,
						progress,
						updatedAt,
					),
				},
				telemetry: {
					provider: 'twitterapi-io',
					paginationComplete: apiBatch.completed,
					paginationStopReason: apiBatch.stopReason,
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
		} catch (error) {
			if (!source.config.fallback) throw error;
			console.warn({
				event: 'source_provider_fallback',
				runId: context.runId,
				sourceId: source.sourceId,
				sourceKey: source.identityNamespace,
				adapterKey: source.adapterKey,
				failedProvider: 'twitterapi-io',
				fallbackProvider: 'rss',
				error: errorMessage(error),
			});

			const items = await loadRssCanonicalItems(
				source.config.fallback,
				source.identityNamespace,
				context.options,
			);
			return {
				items: eligibleItems(items, checkpoint),
				itemLimit: context.options.maxItemsPerSource,
				checkpoint: null,
				telemetry: { provider: 'rss' },
			};
		}
	}
}

export function decodeTwitterApiIoUserAdapterConfig(
	config: unknown,
): TwitterApiIoUserAdapterConfig {
	if (!isRecord(config)) throw new Error('TwitterAPI.io adapter config must be an object');
	const endpoint = requiredString(config.endpoint, 'endpoint');
	assertHttpUrl(endpoint, 'TwitterAPI.io adapter endpoint');
	const apiKey = requiredString(config.apiKey, 'apiKey');
	const userId = nullableString(config.userId, 'userId');
	const userName = nullableString(config.userName, 'userName');
	if (!userId && !userName) {
		throw new Error('TwitterAPI.io adapter requires userId or userName');
	}
	if (typeof config.includeReplies !== 'boolean') {
		throw new Error('TwitterAPI.io adapter includeReplies must be boolean');
	}
	if (
		typeof config.maxPages !== 'number'
		|| !Number.isInteger(config.maxPages)
		|| config.maxPages < 1
		|| config.maxPages > 5
	) {
		throw new Error('TwitterAPI.io adapter maxPages must be an integer from 1 to 5');
	}

	return {
		endpoint,
		apiKey,
		userId,
		userName,
		includeReplies: config.includeReplies,
		maxPages: config.maxPages,
		fallback: config.fallback === null
			? null
			: decodeRssSourceAdapterConfig(config.fallback),
		providerStateKey: optionalString(config.providerStateKey, 'providerStateKey'),
		initializationAt: optionalNonNegativeInteger(config.initializationAt, 'initializationAt'),
		bootstrapUserName: optionalString(config.bootstrapUserName, 'bootstrapUserName'),
	};
}

export function twitterApiStateKey(source: TwitterApiIoUserAdapterConfig): string {
	if (source.providerStateKey) return source.providerStateKey;
	if (source.userId) return `twitterapi-io:user-id:${source.userId}`;
	if (source.userName) return `twitterapi-io:user-name:${source.userName.toLowerCase()}`;
	throw new Error('TwitterAPI.io source requires userId or userName');
}

function eligibleItems<T extends { publishedAt: number | null }>(
	items: T[],
	checkpoint: TwitterApiIoCheckpoint,
): T[] {
	return items.filter((item) => (
		item.publishedAt !== null
		&& item.publishedAt >= checkpoint.initializedAt
	));
}

function nextApiProgress(
	state: TwitterApiIoCheckpoint,
	batch: TwitterApiIoBatch,
): TwitterApiIoCheckpointProgress {
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`TwitterAPI.io adapter ${name} must not be empty`);
	}
	return value.trim();
}

function nullableString(value: unknown, name: string): string | null {
	if (value === null) return null;
	return requiredString(value, name);
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, name);
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`TwitterAPI.io adapter ${name} must be a non-negative integer`);
	}
	return value;
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
