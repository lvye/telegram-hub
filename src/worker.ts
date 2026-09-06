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
import { logSourceReadiness, sourceReadiness } from './health/readiness';
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
import {
	scheduledTaskFor,
	shouldSweepDeliveries,
	sourceMaintenanceStagesFor,
} from './scheduling';

// workerd treats every named export of the entry module as an entrypoint, so
// only the default handler may be exported here; helpers live in scheduling.ts.
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
			const readyDeliveries = await consumeIngestionBatch(
				batch as MessageBatch<IngestionJob>,
				env,
				config,
			);
			if (readyDeliveries > 0) {
				try {
					await dispatchReadyDeliveries(env, config);
				} catch (error) {
					// Undispatched deliveries stay pending for the cron sweep.
					console.error({
						event: 'post_ingestion_dispatch_failed',
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
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
				const config = getConfig(env);
				if (!await authorizedForReadiness(request, config.health.readinessToken)) {
					return Response.json({ error: 'Unauthorized' }, {
						status: 401,
						headers: { 'cache-control': 'no-store' },
					});
				}
				const readiness = await sourceReadiness(env, config);
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

async function authorizedForReadiness(request: Request, token: string | null): Promise<boolean> {
	if (!token) return true;
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return false;
	return timingSafeStringEqual(header.slice('Bearer '.length), token);
}

async function timingSafeStringEqual(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	]);
	return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

async function runUpdate(
	env: Env,
	config: ReturnType<typeof getConfig>,
	scheduledTime: number,
): Promise<void> {
	const failures: unknown[] = [];
	const maintenance = new Set(sourceMaintenanceStagesFor(scheduledTime));
	const stages: Array<readonly [string, () => Promise<unknown>]> = [];
	if (shouldSweepDeliveries(scheduledTime)) {
		stages.push(['delivery_dispatch', () => dispatchReadyDeliveries(env, config)]);
	}
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
