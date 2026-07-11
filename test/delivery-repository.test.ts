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

		const existing = await repository.findExistingItemIdentities('twitter:status', [{
			externalId: 'twitter:123',
			identityAliases: ['https://x.com/OpenAI/status/123'],
		}]);
		expect(existing).toEqual(new Set(['twitter:123']));
		await expect(repository.ensureDeliveriesForCandidates(
			'twitter:status',
			'telegram:TWITTER',
			[{ externalId: 'twitter:123', identityAliases: ['https://x.com/OpenAI/status/123'] }],
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

		await expect(repository.ensureDeliveriesForCandidates(
			'rss:test',
			'telegram:IT_HOME',
			[{ externalId: 'ambiguous', identityAliases: ['alias:one', 'alias:two'] }],
			NOW,
		)).rejects.toThrow('matched multiple items');
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
