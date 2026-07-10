import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, it } from 'vitest';
import type { ItemInput } from '../src/domain/delivery';
import { DeliveryRepository } from '../src/persistence/delivery-repository';

it('backfills legacy delivery states without losing item identity', async () => {
	await applyD1Migrations(env.MIGRATION_DB, env.TEST_MIGRATIONS.slice(0, 2));

	await env.MIGRATION_DB.batch([
		env.MIGRATION_DB.prepare(`
			INSERT INTO pushed_items (
				id, title, source, status, createdAt, updatedAt, sentAt
			) VALUES (?, ?, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`).bind('sent-guid', 'Sent item', 'SOURCE_A'),
		env.MIGRATION_DB.prepare(`
			INSERT INTO pushed_items (
				id, title, source, status, createdAt, updatedAt, lastError
			) VALUES (?, ?, ?, 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'temporary failure')
		`).bind('failed-guid', 'Failed item', 'SOURCE_A'),
		env.MIGRATION_DB.prepare(`
			INSERT INTO pushed_items (
				id, title, source, status, createdAt, updatedAt
			) VALUES (?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`).bind('pending-guid', 'Pending item', 'SOURCE_A'),
		env.MIGRATION_DB.prepare(`
			INSERT INTO pushed_items (
				id, title, link, source, status, createdAt, updatedAt, sentAt
			) VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		`).bind(null, 'Missing ID item', 'https://example.com/legacy-link', 'SOURCE_A'),
	]);

	await applyD1Migrations(env.MIGRATION_DB, env.TEST_MIGRATIONS);

	const result = await env.MIGRATION_DB.prepare(`
		SELECT items.external_id, deliveries.status
		FROM deliveries
		JOIN items ON items.id = deliveries.item_id
		ORDER BY items.external_id
	`).all<{ external_id: string; status: string }>();

	expect(result.results).toEqual([
		{ external_id: 'failed-guid', status: 'retry' },
		{ external_id: 'https://example.com/legacy-link', status: 'sent' },
		{ external_id: 'pending-guid', status: 'blocked' },
		{ external_id: 'sent-guid', status: 'sent' },
	]);

	// Simulate the old Worker writing after 0003 was applied but before the new
	// version became active. Runtime reconciliation must close this cutover gap.
	await env.MIGRATION_DB.prepare(`
		INSERT INTO pushed_items (
			id, title, source, status, createdAt, updatedAt, sentAt
		) VALUES (?, ?, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`).bind('post-migration-guid', 'Post migration item', 'SOURCE_A').run();
	const repository = new DeliveryRepository(env.MIGRATION_DB);
	const now = Math.floor(Date.now() / 1_000);
	await repository.reconcileLegacyRows();

	const reconciled = await env.MIGRATION_DB.prepare(`
		SELECT deliveries.status
		FROM deliveries
		JOIN items ON items.id = deliveries.item_id
		WHERE items.source_key = ? AND items.external_id = ?
	`).bind('SOURCE_A', 'post-migration-guid').first<{ status: string }>();
	expect(reconciled).toEqual({ status: 'sent' });
	await expect(repository.reconcileLegacyRows()).resolves.toBe(0);

	// If the old Worker claims an item while the new Worker has already created
	// its delivery, ambiguous legacy pending must win until the old outcome is
	// known. Otherwise both versions could send the same Telegram message.
	const raceItem: ItemInput = {
		externalId: 'cutover-race-guid',
		title: 'Cutover race',
		description: null,
		link: 'https://example.com/cutover-race',
		author: null,
		imageUrl: null,
		publishedAt: now,
	};
	await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [raceItem], now);
	await env.MIGRATION_DB.prepare(`
		INSERT INTO pushed_items (
			id, title, link, source, status, createdAt, updatedAt
		) VALUES (?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`).bind(
		raceItem.externalId,
		raceItem.title,
		raceItem.link,
		'SOURCE_A',
	).run();
	await repository.reconcileLegacyRows();

	const raceDeliveryId = await env.MIGRATION_DB.prepare(`
		SELECT deliveries.id
		FROM deliveries
		JOIN items ON items.id = deliveries.item_id
		WHERE items.source_key = ? AND items.external_id = ?
	`).bind('SOURCE_A', raceItem.externalId).first<{ id: number }>();
	expect(raceDeliveryId).not.toBeNull();
	await expect(repository.getState(raceDeliveryId!.id)).resolves.toMatchObject({ status: 'blocked' });

	await env.MIGRATION_DB.prepare(`
		UPDATE pushed_items
		SET status = 'failed', updatedAt = CURRENT_TIMESTAMP, lastError = 'old worker failed'
		WHERE id = ?
	`).bind(raceItem.externalId).run();
	await repository.reconcileLegacyRows();
	await expect(repository.getState(raceDeliveryId!.id)).resolves.toMatchObject({ status: 'retry' });

	// An active lease must be protected without advancing the global bridge
	// cursor past the legacy outcome. Once that lease releases, the same legacy
	// row must still be visible and authoritative.
	const deferredItem: ItemInput = {
		...raceItem,
		externalId: 'deferred-legacy-guid',
		title: 'Deferred legacy outcome',
	};
	await repository.upsertItems('SOURCE_A', 'telegram:SOURCE_A', [deferredItem], now);
	const deferredDelivery = await env.MIGRATION_DB.prepare(`
		SELECT deliveries.id
		FROM deliveries
		JOIN items ON items.id = deliveries.item_id
		WHERE items.source_key = ? AND items.external_id = ?
	`).bind('SOURCE_A', deferredItem.externalId).first<{ id: number }>();
	expect(deferredDelivery).not.toBeNull();
	const deferredLease = await repository.acquireLease(
		deferredDelivery!.id,
		'deferred-active-lease',
		now,
		120,
	);
	expect(deferredLease).not.toBeNull();
	await env.MIGRATION_DB.prepare(`
		INSERT INTO pushed_items (
			id, title, link, source, status, createdAt, updatedAt, sentAt
		) VALUES (?, ?, ?, ?, 'sent', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
	`).bind(
		deferredItem.externalId,
		deferredItem.title,
		deferredItem.link,
		'SOURCE_A',
	).run();
	await repository.reconcileLegacyRows();
	await expect(repository.getState(deferredDelivery!.id)).resolves.toMatchObject({ status: 'sending' });

	await repository.releaseForQueueRetry(
		deferredDelivery!.id,
		'deferred-active-lease',
		now,
		'TEST_RELEASE',
		'Release active lease',
		now,
	);
	await repository.reconcileLegacyRows();
	await expect(repository.getState(deferredDelivery!.id)).resolves.toMatchObject({ status: 'sent' });
});
