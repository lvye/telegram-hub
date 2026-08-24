import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import type { CanonicalItem } from '../src/domain/ingestion';
import { DeliveryRepository } from '../src/persistence/delivery-repository';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = 1_783_760_000;

describe('DeliveryRepository', () => {
	const repository = new DeliveryRepository(env.DB);

	beforeEach(async () => {
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(env), NOW);
	});

	it('uses indexed aliases to deduplicate provider-specific identities', async () => {
		await repository.upsertItems('twitter:status', 'telegram:TWITTER', [{
			...item('rss-guid'),
			identityAliases: ['twitter:123', 'https://x.com/OpenAI/status/123'],
			metadata: { provider: 'rss' },
		}], NOW, 'rss:twitter');

		const existing = await repository.resolveExistingItems('twitter:status', [{
			externalId: 'twitter:123',
			identityAliases: ['https://x.com/OpenAI/status/123'],
		}]);
		expect(existing).toEqual([{
			externalId: 'twitter:123',
			itemId: expect.any(Number),
		}]);
		const identityKinds = await env.DB.prepare(`
			SELECT identity_value, identity_kind
			FROM item_identities
			ORDER BY identity_value
		`).all<{ identity_value: string; identity_kind: string }>();
		expect(identityKinds.results).toEqual([
			{ identity_value: 'https://x.com/OpenAI/status/123', identity_kind: 'url' },
			{ identity_value: 'rss-guid', identity_kind: 'canonical' },
			{ identity_value: 'twitter:123', identity_kind: 'provider_id' },
		]);
		await expect(repository.observeAndEnsureDeliveries(
			'telegram:TWITTER',
			existing,
			NOW + 1,
			'rss:twitter',
		)).resolves.toBe(0);
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items) AS items,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries,
				(SELECT COUNT(*) FROM item_observations) AS observations,
				(SELECT json_extract(metadata_json, '$.provider')
					FROM item_observations) AS observation_provider
		`).first();
		expect(counts).toEqual({
			items: 1,
			deliveries: 1,
			observations: 1,
			observation_provider: 'rss',
		});
	});

	it('persists checkpoint pagination with compare-and-swap semantics', async () => {
		const checkpoint = await repository.getOrCreateSourceProviderState(
			'twitter:status', 'rss:twitter', NOW, 60, null,
		);
		await repository.updateSourceIngestionProgress(
			'twitter:status',
			'rss:twitter',
			checkpoint,
			{
				highWaterExternalId: null,
				nextCursor: 'next-page',
				pendingHighWaterExternalId: 'twitter:200',
			},
			NOW + 1,
		);
		await expect(repository.updateSourceIngestionProgress(
			'twitter:status',
			'rss:twitter',
			checkpoint,
			{
				highWaterExternalId: 'twitter:stale',
				nextCursor: null,
				pendingHighWaterExternalId: null,
			},
			NOW + 2,
		)).rejects.toThrow('changed concurrently');
		const row = await env.DB.prepare(`
			SELECT version, cursor, pending_high_water_identity
			FROM source_connector_checkpoints
		`).first();
		expect(row).toEqual({ version: 1, cursor: 'next-page', pending_high_water_identity: 'twitter:200' });
	});

	it('aggregates provider usage by UTC day and preserves provider metadata', async () => {
		await repository.recordProviderUsage('rss:twitter', [{
			operationKey: 'tweet.search.read',
			providerKey: 'twitterapi_io',
			requestCount: 1,
			resourceCount: 2,
			billableUnitCount: 2,
			unitPriceUsdMicros: 150,
		}], NOW);
		await repository.recordProviderUsage('rss:twitter', [{
			operationKey: 'tweet.search.read',
			providerKey: 'twitterapi_io',
			requestCount: 1,
			resourceCount: 0,
			billableUnitCount: 1,
			unitPriceUsdMicros: 150,
		}], NOW + 60);
		await repository.mergeSourceProviderMetadata(
			'rss:twitter',
			{ xOfficialUserId: '4398626122' },
			NOW + 60,
		);
		await repository.setSourceHttpCache(
			'rss:twitter',
			{ etag: 'test-etag', lastModified: null },
			NOW + 61,
		);

		const row = await env.DB.prepare(`
			SELECT
				usage_day, request_count, resource_count, billable_unit_count,
				unit_price_usd_micros,
				billable_unit_count * unit_price_usd_micros AS estimated_cost_usd_micros
			FROM provider_usage_daily
		`).first();
		expect(row).toEqual({
			usage_day: '2026-07-11',
			request_count: 2,
			resource_count: 2,
			billable_unit_count: 3,
			unit_price_usd_micros: 150,
			estimated_cost_usd_micros: 450,
		});
		await expect(repository.getSourceProviderMetadata('rss:twitter')).resolves.toEqual({
			httpEtag: 'test-etag',
			xOfficialUserId: '4398626122',
		});
	});

	it('skips a checkpoint write when progress has not changed', async () => {
		const checkpoint = await repository.getOrCreateSourceProviderState(
			'twitter:status', 'rss:twitter', NOW, 60, null,
		);
		await repository.updateSourceIngestionProgress(
			'twitter:status',
			'rss:twitter',
			checkpoint,
			{
				highWaterExternalId: checkpoint.highWaterExternalId,
				nextCursor: checkpoint.nextCursor,
				pendingHighWaterExternalId: checkpoint.pendingHighWaterExternalId,
			},
			NOW + 1,
		);
		const row = await env.DB.prepare(`
			SELECT version FROM source_connector_checkpoints
		`).first();
		expect(row).toEqual({ version: 0 });
	});

	it('rejects a candidate whose aliases resolve to different items', async () => {
		await repository.upsertItems('rss:test', 'telegram:IT_HOME', [
			{ ...item('one'), identityAliases: ['alias:one'] },
			{ ...item('two'), identityAliases: ['alias:two'] },
		], NOW);

		await expect(repository.resolveExistingItems(
			'rss:test',
			[{ externalId: 'ambiguous', identityAliases: ['alias:one', 'alias:two'] }],
		)).rejects.toThrow('matched multiple items');
	});

	it('resolves large alias sets through bounded primary-key lookups', async () => {
		const aliases = Array.from({ length: 105 }, (_, index) => `alias:${index}`);
		await repository.upsertItems('rss:test', 'telegram:IT_HOME', [
			{ ...item('chunked'), identityAliases: [aliases.at(-1)!] },
		], NOW);

		await expect(repository.resolveExistingItems('rss:test', [{
			externalId: 'provider-guid',
			identityAliases: aliases,
		}])).resolves.toEqual([{
			externalId: 'provider-guid',
			itemId: expect.any(Number),
		}]);
	});

	it('resolves ids across multiple content upsert chunks', async () => {
		const candidates = Array.from(
			{ length: 105 },
			(_, index) => item(`chunked-canonical-${index}`),
		);
		await repository.upsertItems('rss:test', 'telegram:IT_HOME', candidates, NOW);

		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items) AS items,
				(SELECT COUNT(*) FROM item_identities) AS identities,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries
		`).first();
		expect(counts).toEqual({ items: 105, identities: 105, deliveries: 105 });
	});

	it('rolls back content and identity writes when a dependent write fails', async () => {
		await repository.upsertItems('twitter:status', 'telegram:TWITTER', [
			item('existing-observation'),
		], NOW, 'rss:twitter');
		await env.DB.prepare(`
			UPDATE item_observations
			SET provider_item_id = 'atomic-candidate'
		`).run();

		await expect(repository.upsertItems('twitter:status', 'telegram:TWITTER', [{
			...item('atomic-candidate'),
			identityAliases: ['alias:atomic-candidate'],
		}], NOW + 1, 'rss:twitter')).rejects.toThrow();

		const rolledBack = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items
					WHERE canonical_id = 'atomic-candidate') AS items,
				(SELECT COUNT(*) FROM item_identities
					WHERE identity_value IN ('atomic-candidate', 'alias:atomic-candidate')) AS identities,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries
		`).first();
		expect(rolledBack).toEqual({ items: 0, identities: 0, deliveries: 1 });
	});

	it('isolates matching aliases by identity namespace', async () => {
		await repository.upsertItems('rss:first', 'telegram:IT_HOME', [
			{ ...item('first'), identityAliases: ['alias:shared'] },
		], NOW);
		await repository.upsertItems('rss:second', 'telegram:IT_HOME', [
			{ ...item('second'), identityAliases: ['alias:shared'] },
		], NOW);

		const [first] = await repository.resolveExistingItems('rss:first', [{
			externalId: 'provider-first',
			identityAliases: ['alias:shared'],
		}]);
		const [second] = await repository.resolveExistingItems('rss:second', [{
			externalId: 'provider-second',
			identityAliases: ['alias:shared'],
		}]);
		expect(first?.itemId).not.toBe(second?.itemId);
	});

	it('throttles unchanged observation refreshes to once per day', async () => {
		const candidate = { ...item('observed'), identityAliases: ['alias:observed'] };
		await repository.upsertItems(
			'twitter:status',
			'telegram:TWITTER',
			[candidate],
			NOW,
			'rss:twitter',
		);
		const resolved = await repository.resolveExistingItems('twitter:status', [candidate]);

		await repository.observeAndEnsureDeliveries(
			'telegram:TWITTER', resolved, NOW + 86_399, 'rss:twitter',
		);
		await expect(lastObservedAt()).resolves.toBe(NOW);
		await repository.observeAndEnsureDeliveries(
			'telegram:TWITTER', resolved, NOW + 86_400, 'rss:twitter',
		);
		await expect(lastObservedAt()).resolves.toBe(NOW + 86_400);
	});

	it('does not reset a terminal delivery when an unchanged feed item repeats', async () => {
		const candidate = item('terminal');
		await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [candidate], NOW);
		const [deliveryId] = await repository.claimDispatchable(NOW);
		await repository.acquireLease(deliveryId, 'lease', NOW);
		await repository.markSent(deliveryId, 'lease', 'message-1', NOW);

		await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [candidate], NOW + 1);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'sent' });
		await expect(repository.claimDispatchable(NOW + 1)).resolves.toEqual([]);
	});

	it('claims dispatchable deliveries exactly once and releases failed claims', async () => {
		await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [item('claim-once')], NOW);

		const claimed = await repository.claimDispatchable(NOW);
		expect(claimed).toHaveLength(1);
		await expect(repository.getState(claimed[0])).resolves.toMatchObject({ status: 'queued' });
		await expect(repository.claimDispatchable(NOW)).resolves.toEqual([]);

		await repository.releaseDispatchClaims(claimed, NOW);
		await expect(repository.getState(claimed[0])).resolves.toMatchObject({ status: 'ready' });
		await expect(repository.claimDispatchable(NOW)).resolves.toEqual(claimed);
	});

	async function lastObservedAt(): Promise<number | null> {
		const row = await env.DB.prepare(`
			SELECT last_observed_at FROM item_observations
		`).first<{ last_observed_at: number }>();
		return row?.last_observed_at ?? null;
	}
});

function item(externalId: string): CanonicalItem {
	return {
		externalId,
		title: externalId,
		description: 'Description',
		link: `https://example.com/${externalId}`,
		author: null,
		imageUrl: null,
		publishedAt: NOW,
	};
}
