import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config';
import { SourceRuntimeStateRepository } from '../src/persistence/source-runtime-state-repository';
import worker from '../src/worker';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = Math.floor(Date.parse('2026-07-10T04:10:00Z') / 1_000);

describe('source readiness', () => {
	const runtime = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(workerEnv()), NOW);
	});

	it('reports ready while active sources are inside their startup grace period', async () => {
		await syncSources();
		const response = await worker.fetch(
			new Request('https://example.com/health/ready'),
			workerEnv(),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			service: 'telegram-hub',
			status: 'ready',
			activeSources: 2,
			issues: [],
		});
	});

	it('rejects readiness probes without the configured bearer token', async () => {
		const response = await worker.fetch(
			new Request('https://example.com/health/ready'),
			{ ...workerEnv(), READINESS_TOKEN: 'readiness-secret' } as Env,
		);

		expect(response.status).toBe(401);
	});

	it('accepts readiness probes carrying the configured bearer token', async () => {
		await syncSources();
		const response = await worker.fetch(
			new Request('https://example.com/health/ready', {
				headers: { authorization: 'Bearer readiness-secret' },
			}),
			{ ...workerEnv(), READINESS_TOKEN: 'readiness-secret' } as Env,
		);

		expect(response.status).toBe(200);
	});

	it.each([
		'short',
		'readiness-secret-with-a-longer-suffix',
	])('rejects an invalid bearer token regardless of its length', async (token) => {
		const response = await worker.fetch(
			new Request('https://example.com/health/ready', {
				headers: { authorization: `Bearer ${token}` },
			}),
			{ ...workerEnv(), READINESS_TOKEN: 'readiness-secret' } as Env,
		);

		expect(response.status).toBe(401);
	});

	it('reports a dead source as not ready', async () => {
		await syncSources();
		await runtime.claimForQueue('rss:it_home', 'dead-token', NOW, 300);
		await runtime.reconcileDeadLetter('rss:it_home', 'dead-token', NOW);

		const response = await worker.fetch(
			new Request('https://example.com/health/ready'),
			workerEnv(),
		);

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			status: 'not_ready',
			issues: [{ sourceId: 'rss:it_home', reason: 'dead' }],
		});
	});

	it('reports a source that stopped succeeding after its cadence threshold', async () => {
		await syncSources();
		await runtime.acquireLease('rss:it_home', 'lease', NOW, 300);
		await expect(runtime.markSucceeded('rss:it_home', 'lease', NOW + 60, NOW)).resolves.toBe(true);
		expect(await runtime.get('rss:it_home')).toMatchObject({
			lastSuccessAt: NOW,
			pollEverySeconds: 60,
		});

		const config = getConfig(workerEnv());
		config.ingestion.readinessMinimumSeconds = 60;
		const issues = await runtime.listReadinessIssues(NOW + 61, 60, 1);
		expect(issues).toContainEqual(expect.objectContaining({
			sourceId: 'rss:it_home',
			reason: 'stale',
		}));
	});

	async function syncSources() {
		await runtime.syncActiveSources(NOW);
	}
});

function workerEnv(): Env {
	return {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
		DB: env.DB,
		INGESTION_QUEUE: env.INGESTION_QUEUE,
		IT_HOME_CHAT_ID: 'test-it-home-chat',
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_DELIVERY_QUEUE: env.TELEGRAM_DELIVERY_QUEUE,
		TWITTER_CHAT_ID: 'test-twitter-chat',
	};
}
