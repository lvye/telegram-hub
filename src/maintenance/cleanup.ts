import type { AppConfig } from '../config';
import { DeliveryRepositoryV2 } from '../persistence/delivery-repository-v2';

export async function runCleanup(env: Env, config: AppConfig): Promise<void> {
	const repository = new DeliveryRepositoryV2(env.DB_V2);
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
