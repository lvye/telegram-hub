import {
	DELIVERY_DLQ_NAME,
	getConfig,
	INGESTION_DLQ_NAME,
	INGESTION_QUEUE_NAME,
} from './config';
import { consumeDeadLetterBatch, consumeDeliveryBatch } from './delivery/consumer';
import { dispatchReadyDeliveries } from './delivery/dispatcher';
import type { DeliveryJob } from './domain/delivery';
import type { IngestionJob } from './domain/ingestion';
import { sourceReadiness, logSourceReadiness } from './health/readiness';
import {
	consumeIngestionBatch,
	consumeIngestionDeadLetterBatch,
} from './ingestion/consumer';
import { dispatchDueSources } from './ingestion/dispatcher';
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

		await runUpdate(env, config, controller.scheduledTime);
	},

	async queue(batch, env) {
		const config = getConfig(env);
		if (batch.queue === INGESTION_DLQ_NAME) {
			await consumeIngestionDeadLetterBatch(batch as MessageBatch<IngestionJob>, env);
		} else if (batch.queue === INGESTION_QUEUE_NAME) {
			await consumeIngestionBatch(batch as MessageBatch<IngestionJob>, env, config);
		} else if (batch.queue === DELIVERY_DLQ_NAME) {
			await consumeDeadLetterBatch(batch as MessageBatch<DeliveryJob>, env, config);
		} else {
			await consumeDeliveryBatch(batch as MessageBatch<DeliveryJob>, env, config);
		}
	},

	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === 'GET' && url.pathname === '/health') {
			return Response.json({
				service: 'telegram-hub',
				status: 'ok',
				versionId: env.CF_VERSION_METADATA.id,
				versionTag: env.CF_VERSION_METADATA.tag,
			}, {
				headers: { 'cache-control': 'no-store' },
			});
		}
		if (request.method === 'GET' && url.pathname === '/health/ready') {
			try {
				const readiness = await sourceReadiness(env, getConfig(env));
				return Response.json({
					service: 'telegram-hub',
					...readiness,
					versionId: env.CF_VERSION_METADATA.id,
					versionTag: env.CF_VERSION_METADATA.tag,
				}, {
					status: readiness.status === 'ready' ? 200 : 503,
					headers: { 'cache-control': 'no-store' },
				});
			} catch (error) {
				console.error({
					event: 'readiness_check_failed',
					error: error instanceof Error ? error.message : String(error),
				});
				return Response.json({
					service: 'telegram-hub',
					status: 'not_ready',
					error: 'readiness_check_failed',
					versionId: env.CF_VERSION_METADATA.id,
					versionTag: env.CF_VERSION_METADATA.tag,
				}, {
					status: 503,
					headers: { 'cache-control': 'no-store' },
				});
			}
		}

		return Response.json({ error: 'Not found' }, { status: 404 });
	},
} satisfies ExportedHandler<Env, DeliveryJob | IngestionJob>;

async function runUpdate(
	env: Env,
	config: ReturnType<typeof getConfig>,
	scheduledTime: number,
): Promise<void> {
	const failures: unknown[] = [];
	for (const [stage, run] of [
		['delivery_dispatch', () => dispatchReadyDeliveries(env, config)],
		['source_dispatch', () => dispatchDueSources(env, config, scheduledTime)],
		['readiness', () => logSourceReadiness(env, config, Math.floor(scheduledTime / 1_000))],
	] as const) {
		try {
			await run();
		} catch (error) {
			console.error({
				event: 'scheduled_update_stage_failed',
				stage,
				error: error instanceof Error ? error.message : String(error),
			});
			failures.push(error);
		}
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, 'Scheduled update stages failed');
}
