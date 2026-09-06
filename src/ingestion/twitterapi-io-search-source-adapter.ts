import type { TwitterApiIoSearchAdapterConfig } from '../config';
import type {
	IngestionBatch,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointStore,
} from './twitter-api-checkpoint';
import {
	fetchTwitterApiIoSearchBatch,
	type TwitterApiIoSearchBatch,
} from './twitterapi-io';

export const TWITTER_API_IO_SEARCH_ADAPTER_KEY = 'twitterapi-io.search';
const TWITTER_API_IO_TWEET_READ_USD_MICROS = 150;

export class TwitterApiIoSearchSourceAdapter implements SourceAdapter<TwitterApiIoSearchAdapterConfig> {
	readonly key = TWITTER_API_IO_SEARCH_ADAPTER_KEY;

	constructor(
		private readonly checkpoints: TwitterApiIoCheckpointStore,
		private readonly fetchBatch: typeof fetchTwitterApiIoSearchBatch
			= fetchTwitterApiIoSearchBatch,
	) {}

	decodeConfig(config: unknown): TwitterApiIoSearchAdapterConfig {
		return decodeTwitterApiIoSearchAdapterConfig(config);
	}

	async load(
		source: SourceDefinition<TwitterApiIoSearchAdapterConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		const checkpoint = await this.checkpoints.getOrCreate({
			identityNamespace: source.identityNamespace,
			checkpointKey: source.config.providerStateKey,
			fallbackInitializedAt: source.config.initializationAt,
			overlapSeconds: source.config.overlapSeconds,
			bootstrapUserName: null,
		});
		const committedWindowEnd = searchWindowEnd(checkpoint.highWaterExternalId);
		const minimumPublishedAt = checkpoint.nextCursor
			? checkpoint.initializedAt
			: Math.max(
				checkpoint.initializedAt,
				(committedWindowEnd ?? checkpoint.initializedAt) - source.config.overlapSeconds,
			);
		const apiBatch = await this.fetchBatch(source.config, context.options, {
			cursor: checkpoint.nextCursor,
			minimumPublishedAt,
			scheduledAt: context.scheduledAt,
		});
		const progress = nextSearchProgress(checkpoint, apiBatch);

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
				provider: 'twitterapi-io',
				paginationComplete: apiBatch.completed,
				paginationStopReason: apiBatch.stopReason,
				usage: [{
					operationKey: 'tweet.search.read',
					providerKey: 'twitterapi_io',
					requestCount: apiBatch.requestCount,
					resourceCount: apiBatch.resourceCount,
					billableUnitCount: apiBatch.billableUnitCount,
					unitPriceUsdMicros: TWITTER_API_IO_TWEET_READ_USD_MICROS,
				}],
				...(checkpoint.lastSuccessfulPollAt === null ? {
					initialization: {
						historyBoundaryAt: checkpoint.initializedAt,
						handles: source.config.handles,
					},
				} : {}),
			},
		};
	}
}

export function decodeTwitterApiIoSearchAdapterConfig(
	config: unknown,
): TwitterApiIoSearchAdapterConfig {
	if (!isRecord(config)) throw new Error('TwitterAPI.io search config must be an object');
	const endpoint = requiredString(config.endpoint, 'endpoint');
	assertHttpsUrl(endpoint, 'endpoint');
	const apiKey = requiredString(config.apiKey, 'apiKey');
	if (!Array.isArray(config.handles) || config.handles.length < 1 || config.handles.length > 20) {
		throw new Error('TwitterAPI.io search handles must contain 1 to 20 accounts');
	}
	const handles = config.handles.map((value) => twitterHandle(value));
	if (new Set(handles.map((handle) => handle.toLowerCase())).size !== handles.length) {
		throw new Error('TwitterAPI.io search handles must be unique');
	}
	if (typeof config.includeReplies !== 'boolean') {
		throw new Error('TwitterAPI.io search includeReplies must be boolean');
	}
	const maxPages = boundedInteger(config.maxPages, 'maxPages', 1, 5);
	const overlapSeconds = boundedInteger(config.overlapSeconds, 'overlapSeconds', 0, 3_600);
	return {
		apiKey,
		endpoint,
		handles,
		includeReplies: config.includeReplies,
		initializationAt: boundedInteger(
			config.initializationAt,
			'initializationAt',
			0,
			Number.MAX_SAFE_INTEGER,
		),
		maxPages,
		overlapSeconds,
		providerStateKey: requiredString(config.providerStateKey, 'providerStateKey'),
	};
}

function nextSearchProgress(
	checkpoint: TwitterApiIoCheckpoint,
	batch: TwitterApiIoSearchBatch,
): TwitterApiIoCheckpointProgress {
	const pendingHighWater = checkpoint.pendingHighWaterExternalId
		?? batch.newestExternalId
		?? checkpoint.highWaterExternalId;
	if (!batch.completed) {
		if (!batch.nextCursor || !pendingHighWater) {
			throw new Error('TwitterAPI.io search pagination cannot continue without state');
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

function searchWindowEnd(value: string | null): number | null {
	const endAt = value?.match(/^twitter-search-time:(\d+)$/u)?.[1];
	if (!endAt) return null;
	const parsed = Number(endAt);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

function twitterHandle(value: unknown): string {
	const handle = requiredString(value, 'handle').replace(/^@/u, '');
	if (!/^[A-Za-z0-9_]{1,15}$/u.test(handle)) {
		throw new Error(`Invalid TwitterAPI.io search handle: ${handle}`);
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
		throw new Error(`TwitterAPI.io search ${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return Number(value);
}

function requiredString(value: unknown, name: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`TwitterAPI.io search ${name} must not be empty`);
	}
	return value.trim();
}

function assertHttpsUrl(value: string, name: string): void {
	try {
		if (new URL(value).protocol === 'https:') return;
	} catch {
		// Use one sanitized error for malformed and non-HTTPS URLs.
	}
	throw new Error(`TwitterAPI.io search ${name} must be an HTTPS URL`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
