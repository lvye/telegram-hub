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
import { SourceRuntimeStateRepository } from '../src/persistence/source-runtime-state-repository';
import worker from '../src/worker';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = Math.floor(Date.parse('2026-07-10T04:10:00Z') / 1_000);
const SOURCE_ID = 'rss:it_home';

describe('ingestion queue consumer', () => {
	const runtime = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		vi.spyOn(Date, 'now').mockReturnValue(NOW * 1_000);
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(ingestionEnv()), NOW);
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
			SELECT canonical_id AS external_id
			FROM content_items WHERE identity_namespace = 'rss:it-home'
		`).first<{ external_id: string }>();
		expect(item).toEqual({ external_id: 'queued-guid' });
	});

	it('loads only the queued source configuration', async () => {
		const job = await claimedJob();
		await env.DB.prepare(`
			UPDATE source_connectors
			SET
				provider_key = 'twitterapi-io',
				adapter_key = 'twitterapi-io.user-timeline',
				config_json = ?
			WHERE connector_key = 'rss:twitter'
		`).bind(JSON.stringify({
			endpoint: 'https://api.twitterapi.io/twitter/user/last_tweets',
			includeReplies: false,
			maxPages: 1,
			userName: 'OpenAI',
		})).run();
		vi.mocked(globalThis.fetch).mockResolvedValue(rss('point-lookup-guid'));

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({ status: 'idle' });
	});

	it('acks a queued job whose route was paused and releases its claim', async () => {
		const job = await claimedJob();
		await env.DB.prepare(`
			UPDATE source_routes
			SET status = 'paused'
			WHERE source_id = (
				SELECT source_id FROM source_connectors WHERE connector_key = ?
			)
		`).bind(SOURCE_ID).run();

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'idle',
			queueToken: null,
		});
		await expect(runtime.listDueSourceIds(NOW)).resolves.not.toContain(SOURCE_ID);
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

	it('blocks an oversized candidate batch without retrying or persisting content', async () => {
		const job = await claimedJob();
		vi.mocked(globalThis.fetch).mockResolvedValue(rssItems(501));

		const { result } = await dispatch(job);

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(result.retryMessages).toEqual([]);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'blocked',
			lastErrorCode: 'SOURCE_CANDIDATE_LIMIT_EXCEEDED',
		});
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items) AS items,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries
		`).first();
		expect(counts).toEqual({ items: 0, deliveries: 0 });
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

	it('runs through the configured queues and dispatches new deliveries without a cron sweep', async () => {
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
			const delivery = await deliveryState('native-queue-guid');
			expect(delivery).toEqual({ status: 'sent' });
		}, { timeout: 4_000, interval: 20 });
	});

	it('stores feed validators and short-circuits an unchanged feed via 304', async () => {
		const job = await claimedJob();
		vi.mocked(globalThis.fetch).mockResolvedValue(rss('conditional-guid', {
			etag: '"feed-v1"',
			'last-modified': 'Fri, 10 Jul 2026 04:00:00 GMT',
		}));
		await dispatch(job);

		const checkpoint = await env.DB.prepare(`
			SELECT checkpoints.checkpoint_json
			FROM source_connector_checkpoints AS checkpoints
			JOIN source_connectors AS connectors ON connectors.id = checkpoints.connector_id
			WHERE connectors.connector_key = ?
		`).bind(SOURCE_ID).first<{ checkpoint_json: string }>();
		expect(JSON.parse(checkpoint?.checkpoint_json ?? '{}')).toEqual({
			httpEtag: '"feed-v1"',
			httpLastModified: 'Fri, 10 Jul 2026 04:00:00 GMT',
		});

		const later = NOW + 60;
		vi.spyOn(Date, 'now').mockReturnValue(later * 1_000);
		const queueToken = crypto.randomUUID();
		await expect(runtime.claimForQueue(SOURCE_ID, queueToken, later, 300)).resolves.toBe(true);
		const conditionalRequests: Array<{ etag: string | null; lastModified: string | null }> = [];
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			conditionalRequests.push({
				etag: request.headers.get('if-none-match'),
				lastModified: request.headers.get('if-modified-since'),
			});
			return new Response(null, { status: 304 });
		});

		const { result } = await dispatch({
			version: 1, sourceId: SOURCE_ID, queueToken, scheduledAt: later,
		});

		expect(result.explicitAcks).toEqual(['ingestion-message-1']);
		expect(conditionalRequests).toEqual([{
			etag: '"feed-v1"',
			lastModified: 'Fri, 10 Jul 2026 04:00:00 GMT',
		}]);
		expect(await runtime.get(SOURCE_ID)).toMatchObject({
			status: 'idle',
			lastSuccessAt: later,
			nextPollAt: later + 60,
		});
		const counts = await env.DB.prepare(`
			SELECT COUNT(*) AS items FROM content_items
		`).first<{ items: number }>();
		expect(counts).toEqual({ items: 1 });
	});

	async function deliveryState(canonicalId: string): Promise<{ status: string } | null> {
		return env.DB.prepare(`
			SELECT message_deliveries.state AS status
			FROM message_deliveries
			JOIN content_items ON content_items.id = message_deliveries.item_id
			WHERE content_items.canonical_id = ?
		`).bind(canonicalId).first<{ status: string }>();
	}

	async function claimedJob(claimSeconds = 300): Promise<IngestionJob> {
		await runtime.syncActiveSources(NOW);
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
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_DELIVERY_QUEUE: {
			sendBatch: async () => undefined,
		} as unknown as Queue,
		TWITTER_CHAT_ID: 'test-twitter-chat',
	};
}

function rss(guid: string, headers: Record<string, string> = {}): Response {
	return new Response(`
		<rss><channel><item>
			<guid>${guid}</guid>
			<title>Queued item</title>
			<description>Queued description</description>
			<link>https://example.com/${guid}</link>
			<pubDate>Fri, 10 Jul 2026 04:10:00 GMT</pubDate>
		</item></channel></rss>
	`, { headers: { 'content-type': 'application/rss+xml', ...headers } });
}

function rssItems(count: number): Response {
	const items = Array.from({ length: count }, (_, index) => `
		<item>
			<guid>candidate-${index}</guid>
			<title>Candidate ${index}</title>
			<description>Candidate description</description>
			<link>https://example.com/candidate-${index}</link>
			<pubDate>Fri, 10 Jul 2026 04:10:00 GMT</pubDate>
		</item>
	`).join('');
	return new Response(`<rss><channel>${items}</channel></rss>`, {
		headers: { 'content-type': 'application/rss+xml' },
	});
}
