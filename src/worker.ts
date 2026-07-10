import { DELIVERY_DLQ_NAME, getConfig } from './config';
import { consumeDeadLetterBatch, consumeDeliveryBatch } from './delivery/consumer';
import { dispatchReadyDeliveries } from './delivery/dispatcher';
import type { DeliveryJob } from './domain/delivery';
import { ingestSources } from './ingestion/ingest-sources';
import { runCleanup } from './maintenance/cleanup';

export const UPDATE_CRON = '* * * * *';
export const CLEANUP_CRON = '0 4 * * *';

export type ScheduledTask = 'cleanup' | 'update';

export function scheduledTaskFor(cron: string): ScheduledTask {
	if (cron === UPDATE_CRON) return 'update';
	if (cron === CLEANUP_CRON) return 'cleanup';

	throw new Error(`Unsupported cron trigger: ${cron}`);
}

export default {
	async scheduled(controller, env) {
		const config = getConfig(env);
		const task = scheduledTaskFor(controller.cron);

		console.info({
			event: 'scheduled_task_started',
			cron: controller.cron,
			scheduledTime: controller.scheduledTime,
			task,
		});

		if (task === 'cleanup') {
			await runCleanup(env, config);
			return;
		}

		await runUpdate(env, config);
	},

	async queue(batch, env) {
		if (batch.queue === DELIVERY_DLQ_NAME) {
			await consumeDeadLetterBatch(batch, env, getConfig(env));
			return;
		}

		await consumeDeliveryBatch(batch, env, getConfig(env));
	},

	async fetch(request) {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/health') {
			return Response.json({ service: 'telegram-hub', status: 'ok' });
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	},
} satisfies ExportedHandler<Env, DeliveryJob>;

async function runUpdate(env: Env, config: ReturnType<typeof getConfig>): Promise<void> {
	let ingestionError: unknown;

	try {
		await ingestSources(env, config);
	} catch (error) {
		ingestionError = error;
	}

	await dispatchReadyDeliveries(env, config);

	if (ingestionError) throw ingestionError;
}
