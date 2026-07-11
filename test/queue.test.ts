import { env } from 'cloudflare:workers';
import {
	createExecutionContext,
	createMessageBatch,
	getQueueResult,
} from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryJob } from '../src/domain/delivery';
import type { CanonicalItem } from '../src/domain/ingestion';
import { getConfig } from '../src/config';
import { DeliveryRepositoryV2 } from '../src/persistence/delivery-repository-v2';
import worker from '../src/worker';
import { resetV2, seedDefaultV2Topology, seedV2Destination } from './v2-fixtures';

const ITEM: CanonicalItem = {
	externalId: 'queue-item',
	title: 'Queue item',
	description: 'Queue description',
	link: 'https://example.com/queue-item',
	author: null,
	imageUrl: null,
	publishedAt: 1_700_000_000,
};

describe('delivery queue consumer', () => {
	const repository = new DeliveryRepositoryV2(env.DB_V2);

	beforeEach(async () => {
		await resetV2(env.DB_V2);
		await seedDefaultV2Topology(env.DB_V2, getConfig(env), 1_700_000_000);
	});

	it('marks a successful Telegram delivery sent and explicitly acks', async () => {
		const deliveryId = await seedDelivery(repository);
		vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({
			ok: true,
			result: { message_id: 123 },
		}));

		const { result } = await dispatch(deliveryId);
		const row = await env.DB_V2.prepare(`
			SELECT state AS status, provider_message_id
			FROM message_deliveries
			WHERE id = ?
		`).bind(deliveryId).first<{ status: string; provider_message_id: string | null }>();

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		expect(result.retryMessages).toEqual([]);
		expect(row).toEqual({ status: 'sent', provider_message_id: '123' });
	});

	it('uses Telegram retry_after for a delayed queue retry', async () => {
		const deliveryId = await seedDelivery(repository);
		vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({
			ok: false,
			error_code: 429,
			description: 'Too Many Requests',
			parameters: { retry_after: 7 },
		}, { status: 429 }));

		const { result, retry } = await dispatch(deliveryId);

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toEqual([{ msgId: 'queue-message-1' }]);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 7 });
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'queued' });

		// At-least-once delivery may surface a duplicate job before the delayed
		// retry. available_at must prevent it from bypassing Telegram backoff.
		await dispatch(deliveryId);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('records a permanent Telegram error as dead and acks the poison message', async () => {
		const deliveryId = await seedDelivery(repository);
		vi.mocked(globalThis.fetch).mockResolvedValue(Response.json({
			ok: false,
			error_code: 400,
			description: 'Bad Request',
		}, { status: 400 }));

		const { result } = await dispatch(deliveryId);

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'dead' });
	});

	it('marks an unknown destination dead without calling Telegram', async () => {
		await seedV2Destination(env.DB_V2, 'telegram:MISSING', 1_700_000_000);
		await repository.upsertItems('rss:unknown', 'telegram:MISSING', [{
			...ITEM,
			externalId: 'unknown-destination-item',
		}]);
		const [delivery] = await repository.listDispatchable();
		await repository.markQueued([delivery.deliveryId]);

		const { result } = await dispatch(delivery.deliveryId);

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		const row = await env.DB_V2.prepare(`
			SELECT state AS status, last_error_code
			FROM message_deliveries
			WHERE id = ?
		`).bind(delivery.deliveryId).first<{
			last_error_code: string | null;
			status: string;
		}>();
		expect(row).toEqual({ status: 'dead', last_error_code: 'UNKNOWN_DESTINATION' });
	});

	it('acks a duplicate queue message without sending Telegram twice', async () => {
		const deliveryId = await seedDelivery(repository);
		const lease = await repository.acquireLease(deliveryId, 'pre-sent-lease');
		expect(lease).not.toBeNull();
		await repository.markSent(deliveryId, 'pre-sent-lease', '456');

		const { result } = await dispatch(deliveryId);

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('recovers a non-exhausted native dead-letter message for redispatch', async () => {
		const deliveryId = await seedDelivery(repository);

		const { result } = await dispatch(deliveryId, 'telegram-delivery-dlq');

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'retry' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('marks an application-exhausted dead-letter delivery dead', async () => {
		const deliveryId = await seedDelivery(repository);
		await env.DB_V2.prepare(`
			UPDATE message_deliveries
			SET attempt_count = 5
			WHERE id = ?
		`).bind(deliveryId).run();

		const { result } = await dispatch(deliveryId, 'telegram-delivery-dlq');

		expect(result.explicitAcks).toEqual(['queue-message-1']);
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'dead' });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('does not let a stale dead-letter copy clear an active delivery lease', async () => {
		const deliveryId = await seedDelivery(repository);
		const lease = await repository.acquireLease(deliveryId, 'active-lease');
		expect(lease).not.toBeNull();

		const { result, retry } = await dispatch(deliveryId, 'telegram-delivery-dlq');

		expect(result.explicitAcks).toEqual([]);
		expect(result.retryMessages).toEqual([{ msgId: 'queue-message-1' }]);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
		await expect(repository.getState(deliveryId)).resolves.toMatchObject({
			status: 'sending',
			leaseExpiresAt: expect.any(Number),
		});
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('delivers through the configured producer-to-consumer binding', async () => {
		const deliveryId = await seedDelivery(repository);
		// The native queue consumer runs in a distinct request context. Construct
		// the response when fetch is invoked so its body stream belongs to that
		// consumer context rather than to this test's context.
		vi.mocked(globalThis.fetch).mockImplementation(async () => Response.json({
			ok: true,
			result: { message_id: 789 },
		}));

		await env.TELEGRAM_DELIVERY_QUEUE.send({ version: 1, deliveryId });

		await vi.waitFor(async () => {
			await expect(repository.getState(deliveryId)).resolves.toMatchObject({ status: 'sent' });
		}, { timeout: 2_000, interval: 20 });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});
});

async function seedDelivery(repository: DeliveryRepositoryV2): Promise<number> {
	await repository.upsertItems('rss:it-home', 'telegram:IT_HOME', [ITEM]);
	const [delivery] = await repository.listDispatchable();
	await repository.markQueued([delivery.deliveryId]);
	return delivery.deliveryId;
}

async function dispatch(deliveryId: number, queueName = 'telegram-delivery') {
	const batch = createMessageBatch<DeliveryJob>(queueName, [
		{
			id: 'queue-message-1',
			timestamp: new Date('2026-07-10T00:00:00Z'),
			attempts: 1,
			body: { version: 1, deliveryId },
		},
	]);
	const ctx = createExecutionContext();
	const retry = vi.spyOn(batch.messages[0], 'retry');

	await worker.queue(batch, env);
	return {
		result: await getQueueResult(batch, ctx),
		retry,
	};
}
