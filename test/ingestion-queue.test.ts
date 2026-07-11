import { env } from 'cloudflare:workers';
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config';
import type { IngestionJob } from '../src/domain/ingestion';
import { ingestionRetryDelaySeconds } from '../src/ingestion/consumer';
import { D1SourceCatalog } from '../src/ingestion/source-catalog';
import { SourceRuntimeStateRepository } from '../src/persistence/source-runtime-state-repository';
import worker from '../src/worker';

const NOW = Math.floor(Date.parse('2026-07-10T04:10:00Z') / 1_000);
const SOURCE_ID = 'rss:it_home';

describe('ingestion queue consumer', () => {
	const runtime = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
		await env.DB.batch([
			env.DB.prepare('DELETE FROM source_runtime_state'),
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM source_ingestion_state'),
			env.DB.prepare('DELETE FROM twitter_subscriptions'),
		]);
	});

	it('ingests one claimed source, acks it, and releases the runtime lease', async () => {
		const job = await claimedJob();
		vi.mocked(globalThis.fetch).mockResolvedValue(rss('queued-guid'));

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(result.retryMessages).toEqual([]);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'idle',
			consecutiveFailures: 0,
			lastSuccessAt: NOW,
			nextPollAt: NOW + 60,
		});
		const item = await env.DB.prepare(`
			SELECT external_id FROM items WHERE source_key = 'IT_HOME'
		`).first<{ external_id: string }>();
		expect(item).toEqual({ external_id: 'queued-guid' });
	});

	it('uses Retry-After and keeps the same queue token for a delayed retry', async () => {
		const job = await claimedJob();
		vi.spyOn(Math, 'random').mockReturnValue(0);
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('unavailable', {
			status: 503,
			headers: { 'retry-after': '120' },
		}));

		const { result, retry } = await dispatch(job);

		expect(result.retryMessages).toEqual([{ msgId: 'ingestion-message-1' }]);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 120 });
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'queued',
			queueToken: job.queueToken,
			nextPollAt: NOW + 120,
			consecutiveFailures: 1,
			lastErrorCode: 'SOURCE_HTTP_503',
		});
	});

	it('adds bounded jitter to exponential retries', () => {
		expect(ingestionRetryDelaySeconds(1, null, () => 0)).toBe(30);
		expect(ingestionRetryDelaySeconds(3, null, () => 1)).toBe(150);
		expect(ingestionRetryDelaySeconds(1, 90, () => 0)).toBe(90);
		expect(ingestionRetryDelaySeconds(20, null, () => 1)).toBe(4_500);
	});

	it('blocks a permanent upstream 404 without retrying', async () => {
		const job = await claimedJob();
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('missing', { status: 404 }));

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(result.retryMessages).toEqual([]);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'blocked',
			lastErrorCode: 'SOURCE_HTTP_404',
		});
	});

	it('acks a stale job token without fetching the source', async () => {
		const job = await claimedJob();
		await runtime.releaseQueueClaim(job.sourceId, job.queueToken, NOW);
		await runtime.claimForQueue(job.sourceId, 'newer-token', NOW, 300);

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'queued',
			queueToken: 'newer-token',
		});
	});

	it('reclaims an expired queued job after a producer interruption', async () => {
		const job = await claimedJob(30);
		expect(await runtime.listDueSourceIds(NOW + 29)).not.toContain(SOURCE_ID);
		expect(await runtime.listDueSourceIds(NOW + 30)).toContain(SOURCE_ID);
		await expect(runtime.claimForQueue(SOURCE_ID, 'recovered-token', NOW + 30, 300))
			.resolves.toBe(true);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'queued',
			queueToken: 'recovered-token',
		});
		expect(job.queueToken).not.toBe('recovered-token');
	});

	it('reconciles exhausted native retries from the ingestion DLQ', async () => {
		const job = await claimedJob();

		const { result } = await dispatch(job, 'source-ingestion-dlq');

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'dead',
			lastErrorCode: 'INGESTION_QUEUE_DEAD_LETTERED',
		});
	});

	it('recovers a dead-lettered source after the configured cooldown', async () => {
		const job = await claimedJob();
		await runtime.reconcileDeadLetter(SOURCE_ID, job.queueToken, NOW);

		await expect(runtime.recoverDeadSources(NOW + 21_599, 21_600)).resolves.toBe(0);
		await expect(runtime.recoverDeadSources(NOW + 21_600, 21_600)).resolves.toBe(1);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'backoff',
			nextPollAt: NOW + 21_600,
			lastErrorCode: 'INGESTION_DLQ_RECOVERY',
		});
	});

	it('retries a blocked source after its longer recovery cooldown', async () => {
		const job = await claimedJob();
		await runtime.acquireQueuedLease(SOURCE_ID, job.queueToken, 'lease', NOW, 300);
		await runtime.markBlocked(SOURCE_ID, 'lease', 'SOURCE_HTTP_404', 'missing', NOW);

		await expect(runtime.recoverBlockedSources(NOW + 3_599, 3_600)).resolves.toBe(0);
		await expect(runtime.recoverBlockedSources(NOW + 3_600, 3_600)).resolves.toBe(1);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'backoff',
			nextPollAt: NOW + 3_600,
			lastErrorCode: 'INGESTION_BLOCKED_RECOVERY',
		});
	});

	it('runs through the configured ingestion and delivery queues', async () => {
		const job = await claimedJob();
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).hostname === 'api.telegram.org') {
				return Response.json({ ok: true, result: { message_id: 9001 } });
			}
			return rss('native-queue-guid');
		});

		await env.INGESTION_QUEUE.send(job);

		await vi.waitFor(async () => {
			expect(await runtime.get(SOURCE_ID)).toMatchObject({ status: 'idle' });
			const delivery = await env.DB.prepare(`
				SELECT status FROM deliveries
				JOIN items ON items.id = deliveries.item_id
				WHERE items.external_id = 'native-queue-guid'
			`).first<{ status: string }>();
			expect(delivery).toEqual({ status: 'sent' });
		}, { timeout: 2_000, interval: 20 });
	});

	async function claimedJob(claimSeconds = 300): Promise<IngestionJob> {
		const config = getConfig(env);
		const sources = await new D1SourceCatalog(env.DB, config).list();
		await runtime.syncSources(sources, NOW);
		const queueToken = crypto.randomUUID();
		await runtime.claimForQueue(SOURCE_ID, queueToken, NOW, claimSeconds);
		return { version: 1, sourceId: SOURCE_ID, queueToken, scheduledAt: NOW };
	}
});

async function dispatch(job: IngestionJob, queueName = 'source-ingestion') {
	const batch = createMessageBatch<IngestionJob>(queueName, [{
		id: 'ingestion-message-1',
		timestamp: new Date(NOW * 1_000),
		attempts: 1,
		body: job,
	}]);
	const ctx = createExecutionContext();
	const retry = vi.spyOn(batch.messages[0], 'retry');
	await worker.queue(batch, ingestionEnv());
	return { result: await getQueueResult(batch, ctx), retry };
}

function ingestionEnv(): Env {
	return {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
		DB: env.DB,
		INGESTION_QUEUE: env.INGESTION_QUEUE,
		IT_HOME_CHAT_ID: 'test-it-home-chat',
		NITTER_BASE_URL: 'https://nitter.net/',
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_DELIVERY_QUEUE: {
			sendBatch: async () => undefined,
		} as unknown as Queue,
		TWITTER_CHAT_ID: 'test-twitter-chat',
		TWITTER_RSS_URL: 'https://example.com/twitter.xml',
		TWITTER_SOURCE_PROVIDER: 'nitter',
	};
}

function rss(guid: string): Response {
	return new Response(`
		<rss><channel><item>
			<guid>${guid}</guid>
			<title>Queued item</title>
			<description>Queued description</description>
			<link>https://example.com/${guid}</link>
			<pubDate>Fri, 10 Jul 2026 04:10:00 GMT</pubDate>
		</item></channel></rss>
	`, { headers: { 'content-type': 'application/rss+xml' } });
}
