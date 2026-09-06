import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { SourceRuntimeStateRepository } from '../src/persistence/source-runtime-state-repository';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = 1_783_760_000;

describe('SourceRuntimeStateRepository', () => {
	const repository = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(env), NOW);
		await repository.syncActiveSources(NOW);
	});

	it('initializes all active routed connectors with one idempotent operation', async () => {
		await env.DB.prepare('DELETE FROM source_connector_state').run();

		await expect(repository.syncActiveSources(NOW)).resolves.toBe(2);
		await expect(repository.syncActiveSources(NOW + 60)).resolves.toBe(0);
		await expect(repository.listDueSourceIds(NOW)).resolves.toEqual([
			'rss:it_home',
			'rss:twitter',
		]);
	});

	it('claims one due source and protects the queue lease with its token', async () => {
		await expect(repository.listDueSourceIds(NOW)).resolves.toContain('rss:it_home');
		await expect(repository.claimForQueue('rss:it_home', 'queue-1', NOW, 300)).resolves.toBe(true);
		await expect(repository.claimForQueue('rss:it_home', 'queue-2', NOW, 300)).resolves.toBe(false);
		await expect(repository.acquireQueuedLease('rss:it_home', 'queue-2', 'lease', NOW, 300))
			.resolves.toBe(false);
		await expect(repository.acquireQueuedLease('rss:it_home', 'queue-1', 'lease', NOW, 300))
			.resolves.toBe(true);
	});

	it('claims all due sources atomically with distinct queue tokens', async () => {
		const claims = await repository.claimDueSources(NOW, 300);

		expect(claims).toHaveLength(2);
		expect(claims.map(({ sourceId }) => sourceId).sort()).toEqual([
			'rss:it_home',
			'rss:twitter',
		]);
		expect(new Set(claims.map(({ queueToken }) => queueToken)).size).toBe(2);
		expect(claims.every(({ queueToken }) => /^[a-f0-9]{32}$/.test(queueToken))).toBe(true);
		await expect(repository.claimDueSources(NOW, 300)).resolves.toEqual([]);
	});

	it('increments failures across queue retries and clears them after a successful attempt', async () => {
		const claim = (await repository.claimDueSources(NOW, 300))
			.find(({ sourceId }) => sourceId === 'rss:it_home');
		expect(claim).toBeDefined();
		const queueToken = claim!.queueToken;
		await expect(repository.acquireQueuedLease('rss:it_home', queueToken, 'lease-1', NOW, 300))
			.resolves.toBe(true);
		await expect(repository.scheduleQueueRetry(
			'rss:it_home', 'stale-lease', queueToken, NOW + 60, NOW + 360, 'HTTP_503', 'down', NOW,
		)).resolves.toBe(false);
		await expect(repository.scheduleQueueRetry(
			'rss:it_home', 'lease-1', queueToken, NOW + 60, NOW + 360, 'HTTP_503', 'down', NOW,
		)).resolves.toBe(true);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'queued', queueToken, nextPollAt: NOW + 60,
			consecutiveFailures: 1, lastErrorCode: 'HTTP_503', lastError: 'down',
		});
		await expect(repository.acquireQueuedLease('rss:it_home', queueToken, 'early', NOW + 59, 300))
			.resolves.toBe(false);
		await expect(repository.acquireQueuedLease('rss:it_home', queueToken, 'lease-2', NOW + 60, 300))
			.resolves.toBe(true);
		await expect(repository.scheduleQueueRetry(
			'rss:it_home', 'lease-2', queueToken, NOW + 120, NOW + 420, 'HTTP_503', 'still down', NOW + 60,
		)).resolves.toBe(true);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'queued', queueToken, consecutiveFailures: 2,
		});
		await expect(repository.acquireQueuedLease('rss:it_home', queueToken, 'lease-3', NOW + 120, 300))
			.resolves.toBe(true);
		await expect(repository.markSucceeded('rss:it_home', 'stale-lease', NOW + 180, NOW + 120))
			.resolves.toBe(false);
		await expect(repository.markSucceeded('rss:it_home', 'lease-3', NOW + 180, NOW + 120))
			.resolves.toBe(true);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'idle', queueToken: null, leaseToken: null,
			nextPollAt: NOW + 180, lastSuccessAt: NOW + 120,
			consecutiveFailures: 0, lastErrorCode: null, lastError: null,
		});
	});

	it('recovers blocked and dead sources only after each cooldown elapses', async () => {
		await repository.claimForQueue('rss:it_home', 'dead-queue', NOW, 300);
		await repository.reconcileDeadLetter('rss:it_home', 'dead-queue', NOW);
		await repository.claimForQueue('rss:twitter', 'blocked-queue', NOW, 300);
		await repository.acquireQueuedLease(
			'rss:twitter',
			'blocked-queue',
			'blocked-lease',
			NOW,
			300,
		);
		await repository.markBlocked(
			'rss:twitter',
			'blocked-lease',
			'SOURCE_HTTP_404',
			'missing',
			NOW,
		);

		await expect(repository.recoverEligibleSources(NOW + 3_599, 21_600, 3_600))
			.resolves.toBe(0);
		await expect(repository.recoverEligibleSources(NOW + 3_600, 21_600, 3_600))
			.resolves.toBe(1);
		await expect(repository.get('rss:twitter')).resolves.toMatchObject({
			status: 'backoff',
			nextPollAt: NOW + 3_600,
			lastErrorCode: 'INGESTION_BLOCKED_RECOVERY',
		});
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({ status: 'dead' });
		await expect(repository.recoverEligibleSources(NOW + 21_599, 21_600, 3_600))
			.resolves.toBe(0);
		await expect(repository.recoverEligibleSources(NOW + 21_600, 21_600, 3_600))
			.resolves.toBe(1);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'backoff',
			nextPollAt: NOW + 21_600,
			lastErrorCode: 'INGESTION_DLQ_RECOVERY',
		});
	});

	it('reports only active, routed connectors in readiness counts', async () => {
		await env.DB.prepare(`
			UPDATE source_routes SET status = 'paused'
			WHERE source_id = (SELECT id FROM sources WHERE source_key = 'rss:twitter')
		`).run();
		await expect(repository.countActiveSources()).resolves.toBe(1);
	});

	it('does not dispatch or claim a connector after its route is paused', async () => {
		await expect(repository.claimForQueue('rss:it_home', 'queued-before-pause', NOW, 300))
			.resolves.toBe(true);
		await env.DB.prepare(`
			UPDATE source_routes SET status = 'paused'
			WHERE source_id = (SELECT id FROM sources WHERE source_key = 'rss:it-home')
		`).run();

		await expect(repository.acquireQueuedLease(
			'rss:it_home',
			'queued-before-pause',
			'lease',
			NOW,
			300,
		)).resolves.toBe(false);
		await expect(repository.listDueSourceIds(NOW + 301)).resolves.not.toContain('rss:it_home');
		await expect(repository.claimForQueue('rss:it_home', 'queue', NOW + 301, 300))
			.resolves.toBe(false);
	});
});
