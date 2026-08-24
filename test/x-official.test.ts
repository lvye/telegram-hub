import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, XOfficialUserAdapterConfig } from '../src/config';
import type { SourceDefinition } from '../src/domain/ingestion';
import type {
	SourceProviderMetadataStore,
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointStore,
} from '../src/ingestion/twitter-api-checkpoint';
import {
	fetchXOfficialBatch,
	fetchXOfficialUserId,
	X_OFFICIAL_USER_ADAPTER_KEY,
	XOfficialUserSourceAdapter,
} from '../src/ingestion/x-official-source-adapter';

const CONFIG: XOfficialUserAdapterConfig = {
	bearerToken: 'x-test-token',
	endpoint: 'https://api.x.com/2',
	includeReplies: false,
	initializationAt: 1_787_500_000,
	maxPages: 1,
	providerStateKey: 'x:subscription:openai',
	userId: null,
	userName: 'OpenAI',
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

describe('X official API client', () => {
	it('resolves a username with bearer authentication', async () => {
		let request: Request | null = null;
		vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
			request = new Request(input, init);
			return Response.json({ data: { id: '4398626122', username: 'OpenAI' } });
		});

		await expect(fetchXOfficialUserId(CONFIG, OPTIONS)).resolves.toBe('4398626122');
		expect(request!.url).toBe('https://api.x.com/2/users/by/username/OpenAI');
		expect(request!.headers.get('authorization')).toBe('Bearer x-test-token');
	});

	it('uses since_id, excludes replies, and normalizes note text and media', async () => {
		let request: Request | null = null;
		vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
			request = new Request(input, init);
			return Response.json({
				data: [{
					id: '200',
					text: 'short text',
					note_tweet: { text: 'complete long-form text' },
					created_at: '2026-08-23T12:00:00.000Z',
					attachments: { media_keys: ['photo-1'] },
				}],
				includes: {
					media: [{ media_key: 'photo-1', type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }],
				},
				meta: {},
			});
		});

		const batch = await fetchXOfficialBatch(CONFIG, '4398626122', OPTIONS, {
			cursor: null,
			sinceExternalId: 'twitter:199',
		});

		const url = new URL(request!.url);
		expect(url.pathname).toBe('/2/users/4398626122/tweets');
		expect(url.searchParams.get('since_id')).toBe('199');
		expect(url.searchParams.get('exclude')).toBe('replies');
		expect(url.searchParams.get('max_results')).toBe('100');
		expect(batch).toMatchObject({ requestCount: 1, resourceCount: 1 });
		expect(batch.items).toEqual([{
			externalId: 'twitter:200',
			identityAliases: ['twitter:200', 'https://x.com/OpenAI/status/200'],
			title: 'complete long-form text',
			description: null,
			link: 'https://x.com/OpenAI/status/200',
			author: '@OpenAI',
			imageUrl: 'https://pbs.twimg.com/media/test.jpg',
			publishedAt: Date.parse('2026-08-23T12:00:00.000Z') / 1_000,
			metadata: { parser: 'twitter', provider: 'x' },
		}]);
	});

	it('caches the resolved user ID and reports resource-based usage', async () => {
		const checkpoint: TwitterApiIoCheckpoint = {
			highWaterExternalId: 'twitter:199',
			initializedAt: CONFIG.initializationAt,
			lastSuccessfulPollAt: null,
			nextCursor: null,
			pendingHighWaterExternalId: null,
		};
		const checkpoints: TwitterApiIoCheckpointStore = {
			getOrCreate: vi.fn(async () => checkpoint),
			commit: vi.fn(async () => undefined),
		};
		const metadata: SourceProviderMetadataStore = {
			getMetadata: vi.fn(async () => ({})),
			mergeMetadata: vi.fn(async () => undefined),
		};
		const resolveUserId = vi.fn(async () => '4398626122');
		const fetchBatch = vi.fn(async () => ({
			completed: true,
			items: [],
			newestExternalId: null,
			nextCursor: null,
			requestCount: 1,
			resourceCount: 0,
			stopReason: 'end' as const,
		}));
		const adapter = new XOfficialUserSourceAdapter(
			checkpoints,
			metadata,
			resolveUserId,
			fetchBatch,
		);
		const source: SourceDefinition<XOfficialUserAdapterConfig> = {
			sourceId: CONFIG.providerStateKey,
			adapterKey: X_OFFICIAL_USER_ADAPTER_KEY,
			identityNamespace: 'twitter',
			destinationKey: 'telegram:twitter',
			pollEveryMinutes: 5,
			config: CONFIG,
		};

		const batch = await adapter.load(source, {
			options: OPTIONS,
			runId: 'run-1',
			scheduledAt: 1_787_500_300,
		});

		expect(metadata.mergeMetadata).toHaveBeenCalledWith(
			CONFIG.providerStateKey,
			{ xOfficialUserId: '4398626122' },
			1_787_500_300,
		);
		expect(batch.telemetry.usage).toEqual([
			{
				operationKey: 'user.lookup.read',
				providerKey: 'x',
				requestCount: 1,
				resourceCount: 1,
				billableUnitCount: 1,
				unitPriceUsdMicros: 10_000,
			},
			{
				operationKey: 'post.timeline.read',
				providerKey: 'x',
				requestCount: 1,
				resourceCount: 0,
				billableUnitCount: 0,
				unitPriceUsdMicros: 5_000,
			},
		]);
	});
});
