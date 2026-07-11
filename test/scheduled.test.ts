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
	const sendBatch = vi.fn(async (_messages: Parameters<Queue['sendBatch']>[0]) => undefined);
	const workerEnv: Env = {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
		DB: env.DB,
		IT_HOME_CHAT_ID: 'test-it-home-chat',
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_DELIVERY_QUEUE: { sendBatch } as unknown as Queue,
		TWITTER_CHAT_ID: 'test-twitter-chat',
		TWITTER_RSS_URL: 'https://example.com/twitter.xml',
	};

	beforeEach(async () => {
		sendBatch.mockClear();
		await env.DB.batch([
			env.DB.prepare('DELETE FROM source_runtime_state'),
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM pushed_items'),
			env.DB.prepare('DELETE FROM twitter_subscriptions'),
		]);
	});

	it('runs ingestion at 04:00 when the every-minute cron fired', async () => {
		vi.mocked(globalThis.fetch).mockImplementation(async () => rss('scheduled-guid'));
		const controller = createScheduledController({
			cron: UPDATE_CRON,
			scheduledTime: new Date('2026-07-10T04:00:00Z'),
		});

		await worker.scheduled(controller, workerEnv);

		expect(sendBatch).toHaveBeenCalledTimes(1);
		expect(sendBatch.mock.calls[0][0]).toHaveLength(2);
		const states = await env.DB.prepare(`
			SELECT status, COUNT(*) AS count
			FROM deliveries
			GROUP BY status
		`).all<{ status: string; count: number }>();
		expect(states.results).toEqual([{ status: 'queued', count: 2 }]);
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

		expect(sendBatch).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		const item = await env.DB.prepare('SELECT description, image_url, metadata_json FROM items').first<{
			description: string | null;
			image_url: string | null;
			metadata_json: string;
		}>();
		expect(item).toEqual({ description: null, image_url: null, metadata_json: '{}' });
	});
});

function rss(guid: string): Response {
	return new Response(`
		<rss><channel><item>
			<guid>${guid}</guid>
			<title>Scheduled item</title>
			<description>Scheduled description</description>
			<link>https://example.com/${guid}</link>
			<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
		</item></channel></rss>
	`, {
		headers: { 'content-type': 'application/rss+xml' },
	});
}
