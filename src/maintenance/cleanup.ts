import type { AppConfig } from '../config';
import { DeliveryRepository } from '../persistence/delivery-repository';

export async function runCleanup(env: Env, config: AppConfig): Promise<void> {
	const repository = new DeliveryRepository(env.DB);
	const recovered = await repository.recoverStaleDeliveries();
	const compacted = await repository.compactDeliveredItems(
		config.cleanup.retentionDays,
	);

	console.info({
		event: 'delivery_content_compacted',
		retentionDays: config.cleanup.retentionDays,
		recovered,
		compacted,
	});
}
