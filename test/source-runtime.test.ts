import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, type TwitterApiIoUserAdapterConfig } from '../src/config';
import type {
	IngestionBatch,
	SourceAdapter,
	SourceAdapterContext,
	SourceCatalog,
	SourceDefinition,
} from '../src/domain/ingestion';
import { ingestSources } from '../src/ingestion/ingest-sources';
import { SourceAdapterRegistry } from '../src/ingestion/source-adapter-registry';
import type { TwitterApiIoCheckpointStore } from '../src/ingestion/twitter-api-checkpoint';
import {
	TWITTER_API_IO_USER_ADAPTER_KEY,
	TwitterApiIoUserSourceAdapter,
} from '../src/ingestion/twitter-api-source-adapter';

interface FakeSourceConfig {
	prefix: string;
}

const FAKE_ADAPTER_KEY = 'test.fake-v1';
const SCHEDULED_TIME = Date.parse('2026-07-10T04:10:00.000Z');

describe('Source Runtime', () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM source_runtime_state'),
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM source_ingestion_state'),
			env.DB.prepare('DELETE FROM twitter_subscriptions'),
		]);
	});

	it('registers a test-only adapter without extending the orchestrator', async () => {
		const source = fakeSource('test:alpha', 1, 'alpha');
		const catalog: SourceCatalog = { list: vi.fn(async () => [source]) };
		let receivedSource: SourceDefinition<FakeSourceConfig> | null = null;
		let receivedContext: SourceAdapterContext | null = null;
		const adapter: SourceAdapter<FakeSourceConfig> = {
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load(definition, context) {
				receivedSource = definition;
				receivedContext = context;
				return {
					items: [canonicalItem('fake-item-1')],
					itemLimit: null,
					checkpoint: null,
					telemetry: { provider: 'fake' },
				};
			},
		};
		const registry = new SourceAdapterRegistry().register(adapter);

		const result = await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog,
			registry,
		});

		expect(catalog.list).toHaveBeenCalledOnce();
		expect(receivedSource).toEqual(source);
		expect(receivedContext).toMatchObject({
			scheduledAt: Math.floor(SCHEDULED_TIME / 1_000),
		});
		expect(receivedSource).not.toHaveProperty('chatId');
		expect(receivedSource).not.toHaveProperty('parseMode');
		expect(receivedSource).not.toHaveProperty('messageFormat');
		expect(result).toEqual([{
			sourceId: 'test:alpha',
			sourceKey: 'TEST',
			discovered: 1,
		}]);
		const row = await env.DB.prepare(`
			SELECT items.source_key, items.external_id, deliveries.destination_key, deliveries.status
			FROM items
			JOIN deliveries ON deliveries.item_id = items.id
		`).first<{
			destination_key: string;
			external_id: string;
			source_key: string;
			status: string;
		}>();
		expect(row).toEqual({
			source_key: 'TEST',
			external_id: 'fake-item-1',
			destination_key: 'telegram:IT_HOME',
			status: 'ready',
		});
		const runtime = await env.DB.prepare(`
			SELECT status, next_poll_at, consecutive_failures, last_success_at
			FROM source_runtime_state
			WHERE source_id = 'test:alpha'
		`).first();
		expect(runtime).toEqual({
			status: 'idle',
			next_poll_at: Math.floor(SCHEDULED_TIME / 1_000) + 60,
			consecutive_failures: 0,
			last_success_at: Math.floor(SCHEDULED_TIME / 1_000),
		});
	});

	it('records runtime failure for an unregistered adapter without content writes', async () => {
		const source = { ...fakeSource('test:missing', 1, 'missing'), adapterKey: 'missing' };
		const catalog: SourceCatalog = { list: async () => [source] };

		const error = await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog,
			registry: new SourceAdapterRegistry(),
		}).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors[0]).toEqual(expect.objectContaining({
			message: 'Unknown source adapter missing for source test:missing',
		}));
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM items) AS items,
				(SELECT COUNT(*) FROM deliveries) AS deliveries,
				(SELECT COUNT(*) FROM source_ingestion_state) AS checkpoints
		`).first<{ checkpoints: number; deliveries: number; items: number }>();
		expect(counts).toEqual({ checkpoints: 0, deliveries: 0, items: 0 });
		const runtime = await env.DB.prepare(`
			SELECT status, consecutive_failures, last_error_code, last_error
			FROM source_runtime_state
			WHERE source_id = 'test:missing'
		`).first();
		expect(runtime).toEqual({
			status: 'backoff',
			consecutive_failures: 1,
			last_error_code: 'SOURCE_INGESTION_FAILED',
			last_error: 'Unknown source adapter missing for source test:missing',
		});
	});

	it('polls only due catalog entries', async () => {
		const oneMinute = fakeSource('test:one-minute', 1, 'one');
		const fiveMinutes = fakeSource('test:five-minutes', 5, 'five');
		const catalog: SourceCatalog = { list: async () => [oneMinute, fiveMinutes] };
		const calls: Array<{ sourceId: string; scheduledAt: number }> = [];
		const registry = new SourceAdapterRegistry().register<FakeSourceConfig>({
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load(source, context) {
				calls.push({ sourceId: source.sourceId, scheduledAt: context.scheduledAt });
				return {
					items: [canonicalItem(`${source.config.prefix}:${context.scheduledAt}`)],
					itemLimit: null,
					checkpoint: null,
					telemetry: { provider: 'fake' },
				};
			},
		});
		const config = getConfig(env);

		await ingestSources(env, config, SCHEDULED_TIME, { catalog, registry });
		await ingestSources(env, config, SCHEDULED_TIME + 60_000, { catalog, registry });

		expect(calls.map(({ sourceId }) => sourceId)).toEqual([
			'test:one-minute',
			'test:five-minutes',
			'test:one-minute',
		]);
	});

	it('routes an existing canonical item to a newly configured destination', async () => {
		const adapter: SourceAdapter<FakeSourceConfig> = {
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load() {
				return {
					items: [canonicalItem('shared-item')],
					itemLimit: null,
					checkpoint: null,
					telemetry: { provider: 'fake' },
				};
			},
		};
		const registry = new SourceAdapterRegistry().register(adapter);
		const first = fakeSource('test:first-route', 1, 'first');
		const second = {
			...fakeSource('test:second-route', 1, 'second'),
			destinationKey: 'telegram:SECONDARY',
		};

		const config = getConfig(env);
		config.destinations.push({
			destinationKey: 'telegram:SECONDARY',
			chatId: 'secondary-chat',
			parseMode: 'HTML',
			messageFormat: 'article',
		});

		await ingestSources(env, config, SCHEDULED_TIME, {
			catalog: { list: async () => [first] },
			registry,
		});
		await ingestSources(env, config, SCHEDULED_TIME, {
			catalog: { list: async () => [second] },
			registry,
		});

		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM items) AS items,
				(SELECT COUNT(*) FROM deliveries) AS deliveries
		`).first<{ deliveries: number; items: number }>();
		expect(counts).toEqual({ items: 1, deliveries: 2 });
		const destinations = await env.DB.prepare(`
			SELECT destination_key
			FROM deliveries
			ORDER BY destination_key
		`).all<{ destination_key: string }>();
		expect(destinations.results.map(({ destination_key }) => destination_key)).toEqual([
			'telegram:IT_HOME',
			'telegram:SECONDARY',
		]);
	});

	it('rejects invalid catalog topology before invoking an adapter', async () => {
		const load = vi.fn(async () => ({
			items: [],
			itemLimit: null,
			checkpoint: null,
			telemetry: { provider: 'fake' },
		}));
		const registry = new SourceAdapterRegistry().register<FakeSourceConfig>({
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			load,
		});
		const source = {
			...fakeSource('test:invalid-route', 1, 'invalid'),
			destinationKey: 'telegram:MISSING',
		};

		await expect(ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog: { list: async () => [source] },
			registry,
		})).rejects.toThrow(
			'Unknown destination telegram:MISSING for source test:invalid-route',
		);
		expect(load).not.toHaveBeenCalled();
	});

	it('decodes adapter config at the registry boundary', async () => {
		const source = {
			...fakeSource('test:invalid-config', 1, 'valid'),
			config: {},
		};
		const adapter: SourceAdapter<FakeSourceConfig> = {
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load() {
				throw new Error('load must not run');
			},
		};

		const error = await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog: { list: async () => [source] },
			registry: new SourceAdapterRegistry().register(adapter),
		}).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors[0]).toEqual(expect.objectContaining({
			message: 'Fake adapter config requires prefix',
		}));
	});

	it('rejects a checkpoint combined with a finite item limit before persistence', async () => {
		const commit = vi.fn(async () => undefined);
		const unsafeBatch = {
			items: [canonicalItem('unsafe-checkpoint-item')],
			itemLimit: 1,
			checkpoint: { commit },
			telemetry: { provider: 'fake' },
		} as unknown as IngestionBatch;
		const registry = new SourceAdapterRegistry().register<FakeSourceConfig>({
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load() {
				return unsafeBatch;
			},
		});

		const error = await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog: { list: async () => [fakeSource('test:unsafe-checkpoint', 1, 'unsafe')] },
			registry,
		}).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors[0]).toEqual(expect.objectContaining({
			message: 'Source test:unsafe-checkpoint cannot combine itemLimit with a checkpoint',
		}));
		expect(commit).not.toHaveBeenCalled();
		await expect(runtimeCounts()).resolves.toEqual({ deliveries: 0, items: 0 });
	});

	it('commits a checkpoint only after item and delivery persistence', async () => {
		const commit = vi.fn(async () => {
			await expect(runtimeCounts()).resolves.toEqual({ deliveries: 1, items: 1 });
		});
		const registry = new SourceAdapterRegistry().register<FakeSourceConfig>({
			key: FAKE_ADAPTER_KEY,
			decodeConfig: decodeFakeConfig,
			async load() {
				return {
					items: [canonicalItem('checkpointed-item')],
					itemLimit: null,
					checkpoint: { commit },
					telemetry: { provider: 'fake' },
				};
			},
		});

		await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog: { list: async () => [fakeSource('test:checkpoint-order', 1, 'ordered')] },
			registry,
		});

		expect(commit).toHaveBeenCalledOnce();
		expect(commit).toHaveBeenCalledWith(Math.floor(SCHEDULED_TIME / 1_000));
	});

	it('validates Twitter pagination progress before persisting its batch', async () => {
		const commit = vi.fn(async () => undefined);
		const checkpoints: TwitterApiIoCheckpointStore = {
			async getOrCreate() {
				return {
					highWaterExternalId: null,
					initializedAt: 0,
					lastSuccessfulPollAt: null,
					nextCursor: null,
					pendingHighWaterExternalId: null,
				};
			},
			commit,
		};
		const adapter = new TwitterApiIoUserSourceAdapter(checkpoints, async () => ({
			completed: false,
			items: [{ ...canonicalItem('twitter:invalid-page'), publishedAt: 1 }],
			newestExternalId: null,
			nextCursor: null,
			stopReason: 'page-budget',
		}));
		const source: SourceDefinition<TwitterApiIoUserAdapterConfig> = {
			sourceId: 'twitter:test-invalid-page',
			adapterKey: TWITTER_API_IO_USER_ADAPTER_KEY,
			identityNamespace: 'TWITTER',
			destinationKey: 'telegram:TWITTER',
			pollEveryMinutes: 5,
			config: {
				endpoint: 'https://api.twitterapi.io/twitter/user/last_tweets',
				apiKey: 'test-api-key',
				userId: null,
				userName: 'test-account',
				includeReplies: false,
				maxPages: 1,
				fallback: null,
			},
		};

		const error = await ingestSources(env, getConfig(env), SCHEDULED_TIME, {
			catalog: { list: async () => [source] },
			registry: new SourceAdapterRegistry().register(adapter),
		}).catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors[0]).toEqual(expect.objectContaining({
			message: 'TwitterAPI.io pagination cannot continue without a cursor and high-water',
		}));
		expect(commit).not.toHaveBeenCalled();
		await expect(runtimeCounts()).resolves.toEqual({ deliveries: 0, items: 0 });
	});
});

function fakeSource(
	sourceId: string,
	pollEveryMinutes: number,
	prefix: string,
): SourceDefinition<FakeSourceConfig> {
	return {
		sourceId,
		adapterKey: FAKE_ADAPTER_KEY,
		identityNamespace: 'TEST',
		destinationKey: 'telegram:IT_HOME',
		pollEveryMinutes,
		config: { prefix },
	};
}

function canonicalItem(externalId: string) {
	return {
		externalId,
		identityAliases: [externalId],
		title: externalId,
		description: null,
		link: null,
		author: null,
		imageUrl: null,
		publishedAt: null,
	};
}

function decodeFakeConfig(config: unknown): FakeSourceConfig {
	if (
		typeof config !== 'object'
		|| config === null
		|| !('prefix' in config)
		|| typeof config.prefix !== 'string'
		|| !config.prefix.trim()
	) {
		throw new Error('Fake adapter config requires prefix');
	}
	return { prefix: config.prefix };
}

async function runtimeCounts(): Promise<{ deliveries: number; items: number }> {
	return await env.DB.prepare(`
		SELECT
			(SELECT COUNT(*) FROM items) AS items,
			(SELECT COUNT(*) FROM deliveries) AS deliveries
	`).first<{ deliveries: number; items: number }>() ?? { deliveries: 0, items: 0 };
}
