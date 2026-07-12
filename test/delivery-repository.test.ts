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
		}], NOW, 'rss:twitter');

		const existing = await repository.resolveExistingItems('twitter:status', [{
			externalId: 'twitter:123',
			identityAliases: ['https://x.com/OpenAI/status/123'],
		}]);
		expect(existing).toEqual([{
			externalId: 'twitter:123',
			itemId: expect.any(Number),
		}]);
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
				(SELECT COUNT(*) FROM item_observations) AS observations
		`).first();
		expect(counts).toEqual({ items: 1, deliveries: 1, observations: 1 });
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

	it('throttles unchanged observation refreshes to once per hour', async () => {
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
			'telegram:TWITTER', resolved, NOW + 3_599, 'rss:twitter',
		);
		await expect(lastObservedAt()).resolves.toBe(NOW);
		await repository.observeAndEnsureDeliveries(
			'telegram:TWITTER', resolved, NOW + 3_600, 'rss:twitter',
		);
		await expect(lastObservedAt()).resolves.toBe(NOW + 3_600);
	});

	it('does not reset a terminal delivery when an unchanged feed item repeats', async () => {
		const candidate = item('terminal');
		await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [candidate], NOW);
		const [{ deliveryId }] = await repository.listDispatchable(NOW);
		await repository.acquireLease(deliveryId, 'lease', NOW);
		await repository.markSent(deliveryId, 'lease', 'message-1', NOW);

		await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [candidate], NOW + 1);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'sent' });
		await expect(repository.listDispatchable(NOW + 1)).resolves.toEqual([]);
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
