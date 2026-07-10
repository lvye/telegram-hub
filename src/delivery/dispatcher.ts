import type { AppConfig } from '../config';
import type { DeliveryJob } from '../domain/delivery';
import { DeliveryRepository } from '../persistence/delivery-repository';

const QUEUE_SEND_LIMIT = 100;

export async function dispatchReadyDeliveries(env: Env, config: AppConfig): Promise<number> {
	const repository = new DeliveryRepository(env.DB);
	const dispatchable = await repository.listDispatchable(
		undefined,
		config.delivery.dispatchBatchSize,
	);

	for (let offset = 0; offset < dispatchable.length; offset += QUEUE_SEND_LIMIT) {
		const chunk = dispatchable.slice(offset, offset + QUEUE_SEND_LIMIT);
		const jobs = chunk.map(({ deliveryId }) => ({
			body: { version: 1, deliveryId } satisfies DeliveryJob,
		}));

		await env.TELEGRAM_DELIVERY_QUEUE.sendBatch(jobs);
		await repository.markQueued(chunk.map(({ deliveryId }) => deliveryId));
	}

	console.info({
		event: 'deliveries_dispatched',
		count: dispatchable.length,
	});

	return dispatchable.length;
}
