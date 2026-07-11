import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { D1SourceCatalog } from '../src/ingestion/source-catalog';
import { resetDatabase, seedDestination } from './d1-fixtures';

const NOW = 1_783_760_000;

describe('D1SourceCatalog', () => {
	beforeEach(async () => {
		await resetDatabase(env.DB);
		await seedDestination(env.DB, 'telegram:TWITTER', NOW);
	});

	it('builds active RSS and Nitter adapters from normalized topology', async () => {
		await seedConnector({
			sourceKey: 'rss:it-home',
			sourceType: 'rss_feed',
			identityNamespace: 'rss:it-home',
			connectorKey: 'rss:it_home',
			providerKey: 'rss',
			adapterKey: 'rss',
			pollSeconds: 60,
			config: {
				url: 'https://www.ithome.com/rss/',
				parser: 'it-home',
				identityStrategy: 'external-id',
			},
		});
		await seedConnector({
			sourceKey: 'twitter:user:openai',
			sourceType: 'twitter_user',
			identityNamespace: 'twitter:status',
			connectorKey: 'nitter:subscription:5',
			providerKey: 'nitter',
			adapterKey: 'nitter.user-timeline',
			pollSeconds: 300,
			config: { baseUrl: 'https://nitter.net/', userName: 'OpenAI', includeReplies: false },
			initializedAt: NOW - 300,
		});

		const sources = await new D1SourceCatalog(env.DB, getConfig(env)).list();

		expect(sources).toEqual([
			expect.objectContaining({
				sourceId: 'nitter:subscription:5',
				adapterKey: 'nitter.user-timeline',
				identityNamespace: 'twitter:status',
				destinationKey: 'telegram:twitter',
				pollEveryMinutes: 5,
				config: expect.objectContaining({
					feedUrl: 'https://nitter.net/OpenAI/rss',
					initializationAt: NOW - 300,
					userName: 'OpenAI',
				}),
			}),
			expect.objectContaining({
				sourceId: 'rss:it_home',
				adapterKey: 'rss',
				config: expect.objectContaining({ parser: 'it-home' }),
			}),
		]);
	});

	it('excludes paused connectors and inactive routes', async () => {
		await seedConnector({
			sourceKey: 'rss:paused',
			sourceType: 'rss_feed',
			identityNamespace: 'rss:paused',
			connectorKey: 'rss:paused',
			providerKey: 'rss',
			adapterKey: 'rss',
			pollSeconds: 60,
			status: 'paused',
			config: { url: 'https://example.com/rss', parser: 'it-home', identityStrategy: 'external-id' },
		});

		await expect(new D1SourceCatalog(env.DB, getConfig(env)).list()).resolves.toEqual([]);
	});

	it('requires the API secret only for an active TwitterAPI.io connector', async () => {
		await seedConnector({
			sourceKey: 'twitter:user:openai',
			sourceType: 'twitter_user',
			identityNamespace: 'twitter:status',
			connectorKey: 'twitterapi-io:subscription:5',
			providerKey: 'twitterapi-io',
			adapterKey: 'twitterapi-io.user-timeline',
			pollSeconds: 300,
			config: {
				endpoint: 'https://api.twitterapi.io/twitter/user/last_tweets',
				userName: 'OpenAI', includeReplies: false, maxPages: 1,
			},
		});

		await expect(new D1SourceCatalog(env.DB, getConfig(env)).list())
			.rejects.toThrow('requires TWITTERAPI_IO_API_KEY');
		const config = getConfig({ ...env, TWITTERAPI_IO_API_KEY: 'test-key' } as Env);
		const [source] = await new D1SourceCatalog(env.DB, config).list();
		expect(source.config).toMatchObject({ apiKey: 'test-key', userName: 'OpenAI', maxPages: 1 });
	});
});

interface ConnectorSeed {
	sourceKey: string;
	sourceType: 'rss_feed' | 'twitter_user';
	identityNamespace: string;
	connectorKey: string;
	providerKey: string;
	adapterKey: string;
	pollSeconds: number;
	config: Record<string, unknown>;
	status?: 'active' | 'paused';
	initializedAt?: number;
}

async function seedConnector(seed: ConnectorSeed): Promise<void> {
	await env.DB.prepare(`
		INSERT INTO sources (
			source_key, source_type, identity_namespace, status, created_at, updated_at
		) VALUES (?, ?, ?, 'active', ?, ?)
	`).bind(seed.sourceKey, seed.sourceType, seed.identityNamespace, NOW, NOW).run();
	await env.DB.prepare(`
		INSERT INTO source_connectors (
			source_id, connector_key, provider_key, adapter_key, status,
			poll_interval_seconds, config_json, created_at, updated_at
		)
		SELECT id, ?, ?, ?, ?, ?, ?, ?, ? FROM sources WHERE source_key = ?
	`).bind(
		seed.connectorKey, seed.providerKey, seed.adapterKey, seed.status ?? 'active',
		seed.pollSeconds, JSON.stringify(seed.config), NOW, NOW, seed.sourceKey,
	).run();
	await env.DB.prepare(`
		INSERT INTO source_routes (source_id, destination_id, status, created_at, updated_at)
		SELECT sources.id, destinations.id, 'active', ?, ?
		FROM sources, destinations
		WHERE sources.source_key = ? AND destinations.destination_key = 'telegram:twitter'
	`).bind(NOW, NOW, seed.sourceKey).run();
	if (seed.initializedAt !== undefined) {
		await env.DB.prepare(`
			INSERT INTO source_connector_checkpoints (connector_id, initialized_at, updated_at)
			SELECT id, ?, ? FROM source_connectors WHERE connector_key = ?
		`).bind(seed.initializedAt, NOW, seed.connectorKey).run();
	}
}
