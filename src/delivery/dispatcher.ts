import type { AppConfig } from '../config';
import type { DeliveryJob } from '../domain/delivery';
import { DeliveryRepository } from '../persistence/delivery-repository';

const QUEUE_SEND_LIMIT = 100;

export async function dispatchReadyDeliveries(env: Env, config: AppConfig): Promise<number> {
	const repository = new DeliveryRepository(env.DB);
	const claimed = await repository.claimDispatchable(
		undefined,
		config.delivery.dispatchBatchSize,
	);

	let offset = 0;
	try {
		while (offset < claimed.length) {
			const chunk = claimed.slice(offset, offset + QUEUE_SEND_LIMIT);
			await env.TELEGRAM_DELIVERY_QUEUE.sendBatch(chunk.map((deliveryId) => ({
				body: { version: 1, deliveryId } satisfies DeliveryJob,
			})));
			offset += chunk.length;
		}
	} catch (error) {
		try {
			await repository.releaseDispatchClaims(claimed.slice(offset));
		} catch (releaseError) {
			// Unreleased claims stay 'queued' until the stale-queue recovery sweep.
			console.error({
				event: 'delivery_dispatch_release_failed',
				count: claimed.length - offset,
				error: releaseError instanceof Error ? releaseError.message : String(releaseError),
			});
		}
		throw error;
	}

	if (claimed.length > 0) {
		console.info({
			event: 'deliveries_dispatched',
			count: claimed.length,
		});
	}

	return claimed.length;
}
