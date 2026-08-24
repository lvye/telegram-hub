import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, TwitterApiIoSearchAdapterConfig } from '../src/config';
import type { SourceDefinition } from '../src/domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointStore,
} from '../src/ingestion/twitter-api-checkpoint';
import { fetchTwitterApiIoSearchBatch } from '../src/ingestion/twitterapi-io';
import {
	TWITTER_API_IO_SEARCH_ADAPTER_KEY,
	TwitterApiIoSearchSourceAdapter,
} from '../src/ingestion/twitterapi-io-search-source-adapter';

const SOURCE: TwitterApiIoSearchAdapterConfig = {
	apiKey: 'test-api-key',
	endpoint: 'https://api.twitterapi.io/twitter/tweet/advanced_search',
	handles: ['MacroMargin', 'OpenAI', 'fxtrader', 'caolei1', 'waylybaye'],
	includeReplies: false,
	initializationAt: 1_787_500_000,
	maxPages: 1,
	overlapSeconds: 120,
	providerStateKey: 'twitterapi-io:search:five-accounts',
};

const OPTIONS: AppConfig['ingestion'] = {
	feedTimeoutMs: 1_000,
	maxFeedBytes: 100_000,
	maxCandidatesPerSource: 500,
	maxIdentityAliasesPerSource: 1_000,
	maxItemsPerSource: 50,
	leaseSeconds: 300,
	queueClaimSeconds: 300,
	deadRecoverySeconds: 21_600,
	blockedRecoverySeconds: 3_600,
	readinessMinimumSeconds: 600,
	readinessPollMultiplier: 3,
};

describe('TwitterAPI.io combined search client', () => {
	it('queries all five accounts once and normalizes only matching non-replies', async () => {
		let request: Request | null = null;
		vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
			request = new Request(input, init);
			return searchResponse([
				tweet('100', 'OpenAI'),
				{ ...tweet('101', 'fxtrader'), isReply: true },
				tweet('102', 'unconfigured'),
			]);
		});

		const batch = await fetchTwitterApiIoSearchBatch(SOURCE, OPTIONS, {
			cursor: null,
			minimumPublishedAt: 1_787_500_000,
			scheduledAt: 1_787_500_300,
		});

		expect(request).not.toBeNull();
		const url = new URL(request!.url);
		expect(url.searchParams.get('queryType')).toBe('Latest');
		expect(url.searchParams.get('cursor')).toBe('');
		expect(url.searchParams.get('query')).toBe(
			'(from:MacroMargin OR from:OpenAI OR from:fxtrader OR from:caolei1 OR from:waylybaye) '
			+ '-filter:replies since_time:1787500000 until_time:1787500300',
		);
		expect(request!.headers.get('X-API-Key')).toBe('test-api-key');
		expect(batch.items.map((item) => item.externalId)).toEqual(['twitter:100']);
		expect(batch).toMatchObject({
			billableUnitCount: 3,
			completed: true,
			newestExternalId: 'twitter-search-time:1787500300',
			requestCount: 1,
			resourceCount: 3,
			stopReason: 'end',
		});
	});

	it('charges the provider minimum for an empty search response', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(searchResponse([]));

		await expect(fetchTwitterApiIoSearchBatch(SOURCE, OPTIONS, {
			cursor: null,
			minimumPublishedAt: 1_787_500_000,
			scheduledAt: 1_787_500_300,
		})).resolves.toMatchObject({
			billableUnitCount: 1,
			requestCount: 1,
			resourceCount: 0,
		});
	});

	it('keeps the original time window in a resumable pagination cursor', async () => {
		const queries: string[] = [];
		vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
			const url = new URL(new Request(input).url);
			queries.push(url.searchParams.get('query') ?? '');
			return url.searchParams.get('cursor')
				? searchResponse([tweet('1', 'OpenAI')])
				: searchResponse([tweet('2', 'OpenAI')], true, 'older-page');
		});

		const first = await fetchTwitterApiIoSearchBatch(SOURCE, OPTIONS, {
			cursor: null,
			minimumPublishedAt: 1_787_500_000,
			scheduledAt: 1_787_500_300,
		});
		expect(first).toMatchObject({ completed: false, stopReason: 'page-budget' });
		expect(first.nextCursor).toContain('older-page');

		const second = await fetchTwitterApiIoSearchBatch(SOURCE, OPTIONS, {
			cursor: first.nextCursor,
			minimumPublishedAt: 1_787_400_000,
			scheduledAt: 1_787_600_000,
		});
		expect(second).toMatchObject({ completed: true, newestExternalId: null });
		expect(queries[1]).toBe(queries[0]);
	});

	it('advances from the committed search window rather than runtime success time', async () => {
		const checkpoint: TwitterApiIoCheckpoint = {
			highWaterExternalId: 'twitter-search-time:1787500300',
			initializedAt: 1_787_500_000,
			lastSuccessfulPollAt: 1_787_600_000,
			nextCursor: null,
			pendingHighWaterExternalId: null,
		};
		const checkpoints: TwitterApiIoCheckpointStore = {
			getOrCreate: vi.fn(async () => checkpoint),
			commit: vi.fn(async () => undefined),
		};
		const fetchBatch = vi.fn(async () => ({
			completed: true,
			items: [],
			newestExternalId: 'twitter-search-time:1787500600',
			nextCursor: null,
			requestCount: 1,
			resourceCount: 0,
			billableUnitCount: 1,
			stopReason: 'end' as const,
		}));
		const adapter = new TwitterApiIoSearchSourceAdapter(checkpoints, fetchBatch);
		const source: SourceDefinition<TwitterApiIoSearchAdapterConfig> = {
			sourceId: SOURCE.providerStateKey,
			adapterKey: TWITTER_API_IO_SEARCH_ADAPTER_KEY,
			identityNamespace: 'twitter:status',
			destinationKey: 'telegram:twitter',
			pollEveryMinutes: 5,
			config: SOURCE,
		};

		const batch = await adapter.load(source, {
			options: OPTIONS,
			runId: 'run-1',
			scheduledAt: 1_787_500_600,
		});

		expect(fetchBatch).toHaveBeenCalledWith(
			SOURCE,
			OPTIONS,
			{
				cursor: null,
				minimumPublishedAt: 1_787_500_180,
				scheduledAt: 1_787_500_600,
			},
		);
		await batch.checkpoint!.commit(1_787_500_600);
		expect(checkpoints.commit).toHaveBeenCalledWith(
			'twitter:status',
			SOURCE.providerStateKey,
			checkpoint,
			{
				highWaterExternalId: 'twitter-search-time:1787500600',
				nextCursor: null,
				pendingHighWaterExternalId: null,
			},
			1_787_500_600,
		);
	});
});

function tweet(id: string, userName: string): Record<string, unknown> {
	return {
		id,
		url: `https://x.com/${userName}/status/${id}`,
		text: `tweet ${id}`,
		createdAt: 'Sun Aug 23 12:00:00 +0000 2026',
		author: { name: userName, userName },
	};
}

function searchResponse(
	tweets: Array<Record<string, unknown>>,
	hasNextPage = false,
	nextCursor = '',
): Response {
	return Response.json({
		status: 'success',
		tweets,
		has_next_page: hasNextPage,
		next_cursor: nextCursor,
	});
}
