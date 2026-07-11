import { env } from 'cloudflare:workers';
import { createScheduledController } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalItem } from '../src/domain/ingestion';
import { DeliveryRepository } from '../src/persistence/delivery-repository';
import worker, { CLEANUP_CRON, UPDATE_CRON } from '../src/worker';

const ITEM: CanonicalItem = {
	externalId: 'cleanup-item',
	title: 'Cleanup item',
	description: 'Payload to compact',
	link: 'https://example.com/cleanup',
	author: null,
	imageUrl: 'https://example.com/image.jpg',
	publishedAt: 1_000,
	metadata: {
		descriptionFormat: 'telegram-html-v1',
		telegramHtmlDescription: '<b>Payload</b>',
	},
};

describe('scheduled handler', () => {
	const sendDeliveryBatch = vi.fn(async (_messages: Parameters<Queue['sendBatch']>[0]) => undefined);
	const sendIngestionBatch = vi.fn(async (_messages: Parameters<Queue['sendBatch']>[0]) => undefined);
	const workerEnv: Env = {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
		DB: env.DB,
		IT_HOME_CHAT_ID: 'test-it-home-chat',
		NITTER_BASE_URL: 'https://nitter.net/',
		TELEGRAM_BOT_TOKEN: 'test-token',
		INGESTION_QUEUE: { sendBatch: sendIngestionBatch } as unknown as Queue,
		TELEGRAM_DELIVERY_QUEUE: { sendBatch: sendDeliveryBatch } as unknown as Queue,
		TWITTER_CHAT_ID: 'test-twitter-chat',
		TWITTER_RSS_URL: 'https://example.com/twitter.xml',
		TWITTER_SOURCE_PROVIDER: 'nitter',
	};

	beforeEach(async () => {
		sendDeliveryBatch.mockClear();
		sendIngestionBatch.mockClear();
		await env.DB.batch([
			env.DB.prepare('DELETE FROM source_runtime_state'),
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM pushed_items'),
			env.DB.prepare('DELETE FROM twitter_subscriptions'),
		]);
	});

	it('enqueues one job per due source without fetching in the cron invocation', async () => {
		const controller = createScheduledController({
			cron: UPDATE_CRON,
			scheduledTime: new Date('2026-07-10T04:00:00Z'),
		});

		await worker.scheduled(controller, workerEnv);

		expect(sendIngestionBatch).toHaveBeenCalledTimes(1);
		expect(sendIngestionBatch.mock.calls[0][0]).toHaveLength(2);
		expect(sendDeliveryBatch).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		const states = await env.DB.prepare(`
			SELECT source_id, status, queue_token
			FROM source_runtime_state
			ORDER BY source_id
		`).all<{ queue_token: string; source_id: string; status: string }>();
		expect(states.results).toEqual([
			{ source_id: 'rss:it_home', status: 'queued', queue_token: expect.any(String) },
			{ source_id: 'rss:twitter', status: 'queued', queue_token: expect.any(String) },
		]);

		await worker.scheduled(controller, workerEnv);
		expect(sendIngestionBatch).toHaveBeenCalledTimes(1);
	});

	it('releases source claims when the ingestion producer fails', async () => {
		sendIngestionBatch.mockRejectedValueOnce(new Error('queue unavailable'));
		const controller = createScheduledController({
			cron: UPDATE_CRON,
			scheduledTime: new Date('2026-07-10T04:00:00Z'),
		});

		await expect(worker.scheduled(controller, workerEnv)).rejects.toThrow('queue unavailable');
		const states = await env.DB.prepare(`
			SELECT status, queue_token
			FROM source_runtime_state
			ORDER BY source_id
		`).all<{ queue_token: string | null; status: string }>();
		expect(states.results).toEqual([
			{ status: 'idle', queue_token: null },
			{ status: 'idle', queue_token: null },
		]);
	});

	it('runs only compaction for the cleanup cron', async () => {
		const repository = new DeliveryRepository(env.DB);
		await repository.upsertItems('IT_HOME', 'telegram:IT_HOME', [ITEM], 1_000);
		const [{ deliveryId }] = await repository.listDispatchable(1_000);
		await repository.acquireLease(deliveryId, 'cleanup-lease', 1_000);
		await repository.markSent(deliveryId, 'cleanup-lease', '1', 1_001);
		const controller = createScheduledController({
			cron: CLEANUP_CRON,
			scheduledTime: new Date('2026-07-10T04:00:00Z'),
		});

		await worker.scheduled(controller, workerEnv);

		expect(sendDeliveryBatch).not.toHaveBeenCalled();
		expect(sendIngestionBatch).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		const item = await env.DB.prepare('SELECT description, image_url, metadata_json FROM items').first<{
			description: string | null;
			image_url: string | null;
			metadata_json: string;
		}>();
		expect(item).toEqual({ description: null, image_url: null, metadata_json: '{}' });
	});
});
