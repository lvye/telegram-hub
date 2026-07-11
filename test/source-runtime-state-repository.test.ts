import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { D1SourceCatalog } from '../src/ingestion/source-catalog';
import { SourceRuntimeStateRepository } from '../src/persistence/source-runtime-state-repository';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = 1_783_760_000;

describe('SourceRuntimeStateRepository', () => {
	const repository = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(env), NOW);
		const sources = await new D1SourceCatalog(env.DB, getConfig(env)).list();
		await repository.syncSources(sources, NOW);
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

	it('records failure backoff and clears it after a successful attempt', async () => {
		await repository.claimForQueue('rss:it_home', 'queue', NOW, 300);
		await repository.acquireQueuedLease('rss:it_home', 'queue', 'lease-1', NOW, 300);
		await repository.markFailed('rss:it_home', 'lease-1', NOW + 60, 'HTTP_503', 'down', NOW);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'backoff', consecutiveFailures: 1, lastErrorCode: 'HTTP_503',
		});

		await repository.acquireLease('rss:it_home', 'lease-2', NOW + 60, 300);
		await repository.markSucceeded('rss:it_home', 'lease-2', NOW + 120, NOW + 60);
		await expect(repository.get('rss:it_home')).resolves.toMatchObject({
			status: 'idle', consecutiveFailures: 0, lastErrorCode: null,
		});
	});

	it('reports only active, routed connectors in readiness counts', async () => {
		await env.DB.prepare(`
			UPDATE source_routes SET status = 'paused'
			WHERE source_id = (SELECT id FROM sources WHERE source_key = 'rss:twitter')
		`).run();
		await expect(repository.countActiveSources()).resolves.toBe(1);
	});
});
