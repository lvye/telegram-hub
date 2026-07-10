import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemInput } from '../src/domain/delivery';
import { DeliveryRepository } from '../src/persistence/delivery-repository';

const ITEM: ItemInput = {
	externalId: 'shared-guid',
	title: 'Example item',
	description: 'Example description',
	link: 'https://example.com/item',
	author: null,
	imageUrl: null,
	publishedAt: 1_700_000_000,
};

describe('DeliveryRepository', () => {
	const repository = new DeliveryRepository(env.DB);

	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM pushed_items'),
		]);
	});

	it('keeps the same external id independent across sources', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		await repository.upsertItems('SOURCE_B', 'telegram:SOURCE_B', [ITEM], 1_000);

		const items = await env.DB.prepare('SELECT source_key FROM items ORDER BY source_key').all<{ source_key: string }>();
		const deliveries = await repository.listDispatchable(1_000);

		expect(items.results.map((row) => row.source_key)).toEqual(['SOURCE_A', 'SOURCE_B']);
		expect(deliveries).toHaveLength(2);
	});

	it('persists a full 50-item ingestion batch within D1 binding limits', async () => {
		const items = Array.from({ length: 50 }, (_, index): ItemInput => ({
			...ITEM,
			externalId: `batch-item-${index}`,
			link: `https://example.com/items/${index}`,
		}));

		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', items, 1_000);

		const itemCount = await env.DB.prepare(`
			SELECT COUNT(*) AS count
			FROM items
			WHERE source_key = 'SOURCE_A'
		`).first<{ count: number }>();
		expect(itemCount?.count).toBe(50);
		await expect(repository.listDispatchable(1_000, 100)).resolves.toHaveLength(50);
	});

	it('does not rewrite an unchanged feed item', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 2_000);

		const row = await env.DB.prepare(`
			SELECT updated_at
			FROM items
			WHERE source_key = ? AND external_id = ?
		`).bind('SOURCE_A', ITEM.externalId).first<{ updated_at: number }>();
		expect(row).toEqual({ updated_at: 1_000 });
	});

	it('does not reset a terminal delivery when the feed repeats an item', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);
		const lease = await repository.acquireLease(deliveryId, 'lease-1', 1_000, 120);

		expect(lease).not.toBeNull();
		await expect(repository.markSent(deliveryId, 'lease-1', '42', 1_001)).resolves.toBe(true);

		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [{ ...ITEM, title: 'Updated title' }], 2_000);

		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'sent' });
		await expect(repository.listDispatchable(2_000)).resolves.toEqual([]);
	});

	it('reclaims only an expired sending lease', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);

		const first = await repository.acquireLease(deliveryId, 'lease-1', 1_000, 120);
		const stillLeased = await repository.acquireLease(deliveryId, 'lease-2', 1_119, 120);
		const reclaimed = await repository.acquireLease(deliveryId, 'lease-3', 1_120, 120);

		expect(first?.attemptCount).toBe(1);
		expect(stillLeased).toBeNull();
		expect(reclaimed).toMatchObject({ attemptCount: 2, leaseToken: 'lease-3' });
	});

	it('honors retry available_at when a duplicate queue job arrives early', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);
		const lease = await repository.acquireLease(deliveryId, 'lease-1', 1_000, 120);
		expect(lease).not.toBeNull();
		await repository.releaseForQueueRetry(
			deliveryId,
			'lease-1',
			1_007,
			'TELEGRAM_RATE_LIMITED',
			'Try later',
			1_000,
		);

		await expect(repository.acquireLease(deliveryId, 'too-early', 1_001, 120)).resolves.toBeNull();
		await expect(repository.acquireLease(deliveryId, 'on-time', 1_007, 120)).resolves.toMatchObject({
			leaseToken: 'on-time',
			attemptCount: 2,
		});
	});

	it('does not mark an active final-attempt lease dead', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);

		for (let attempt = 1; attempt < 5; attempt += 1) {
			const token = `lease-${attempt}`;
			const lease = await repository.acquireLease(deliveryId, token, 1_000 + attempt, 120, 5);
			expect(lease?.attemptCount).toBe(attempt);
			await repository.releaseForQueueRetry(
				deliveryId,
				token,
				1_000 + attempt,
				'TEST_RETRY',
				'Retry',
				1_000 + attempt,
			);
		}

		const finalLease = await repository.acquireLease(deliveryId, 'lease-5', 1_010, 120, 5);
		expect(finalLease?.attemptCount).toBe(5);
		await expect(repository.markDeadIfExhausted(
			deliveryId,
			5,
			'DELIVERY_ATTEMPTS_EXHAUSTED',
			'Exhausted',
			1_011,
		)).resolves.toBe(false);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'sending' });
		await expect(repository.markSent(deliveryId, 'lease-5', '123', 1_012)).resolves.toBe(true);
	});

	it('recovers stale queued deliveries for redispatch', async () => {
		await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);
		await repository.markQueued([deliveryId], 1_000);

		await expect(repository.recoverStaleDeliveries(173_800, 172_800)).resolves.toBe(1);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'retry' });
		await expect(repository.listDispatchable(173_800)).resolves.toEqual([{ deliveryId }]);
	});
});
