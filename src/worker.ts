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
import {
	dispatchDueSources,
	recoverSourceRuntime,
	syncSourceRuntime,
} from './ingestion/dispatcher';
import { runCleanup } from './maintenance/cleanup';

export const UPDATE_CRON = '* * * * *';
export const CLEANUP_CRON = '0 4 * * *';

export type ScheduledTask = 'cleanup' | 'update';
export type SourceMaintenanceStage = 'readiness' | 'source_recovery' | 'source_sync';

const MINUTE_MS = 60_000;
const SOURCE_MAINTENANCE_INTERVAL_MINUTES = 15;
const SOURCE_SYNC_OFFSET_MINUTES = 1;
const SOURCE_RECOVERY_OFFSET_MINUTES = 6;
const READINESS_OFFSET_MINUTES = 11;

export function scheduledTaskFor(cron: string): ScheduledTask {
	if (cron === UPDATE_CRON) return 'update';
	if (cron === CLEANUP_CRON) return 'cleanup';

	throw new Error(`Unsupported cron trigger: ${cron}`);
}

/**
 * Spreads heavier source maintenance across the 15-minute cycle. Normal due-source
 * dispatch still runs every minute, so existing 60-second poll intervals are unchanged.
 */
export function sourceMaintenanceStagesFor(scheduledTime: number): SourceMaintenanceStage[] {
	const minute = Math.floor(scheduledTime / MINUTE_MS);
	const offset = ((minute % SOURCE_MAINTENANCE_INTERVAL_MINUTES)
		+ SOURCE_MAINTENANCE_INTERVAL_MINUTES) % SOURCE_MAINTENANCE_INTERVAL_MINUTES;
	if (offset === SOURCE_SYNC_OFFSET_MINUTES) return ['source_sync'];
	if (offset === SOURCE_RECOVERY_OFFSET_MINUTES) return ['source_recovery'];
	if (offset === READINESS_OFFSET_MINUTES) return ['readiness'];
	return [];
}

export default {
	async scheduled(controller, env) {
		const config = getConfig(env);
		const task = scheduledTaskFor(controller.cron);

		if (task === 'cleanup') {
			console.info({
				event: 'scheduled_task_started',
				cron: controller.cron,
				scheduledTime: controller.scheduledTime,
				task,
			});
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
	const maintenance = new Set(sourceMaintenanceStagesFor(scheduledTime));
	const stages: Array<readonly [string, () => Promise<unknown>]> = [
		['delivery_dispatch', () => dispatchReadyDeliveries(env, config)],
	];
	if (maintenance.has('source_sync')) {
		stages.push(['source_sync', () => syncSourceRuntime(env, scheduledTime)]);
	}
	if (maintenance.has('source_recovery')) {
		stages.push(['source_recovery', () => recoverSourceRuntime(env, config, scheduledTime)]);
	}
	stages.push(['source_dispatch', () => dispatchDueSources(env, config, scheduledTime)]);
	if (maintenance.has('readiness')) {
		stages.push([
			'readiness',
			() => logSourceReadiness(env, config, Math.floor(scheduledTime / 1_000)),
		]);
	}

	for (const [stage, run] of stages) {
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
