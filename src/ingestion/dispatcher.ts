import type { AppConfig } from '../config';
import type { IngestionJob } from '../domain/ingestion';
import { SourceRuntimeStateRepository } from '../persistence/source-runtime-state-repository';

const QUEUE_SEND_LIMIT = 100;

export async function dispatchDueSources(
	env: Env,
	config: AppConfig,
	scheduledTime = Date.now(),
): Promise<number> {
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	const runtime = new SourceRuntimeStateRepository(env.DB);
	const claims = await runtime.claimDueSources(
		scheduledAt,
		config.ingestion.queueClaimSeconds,
		QUEUE_SEND_LIMIT,
	);
	const jobs: IngestionJob[] = claims.map(({ sourceId, queueToken }) => ({
		version: 1,
		sourceId,
		queueToken,
		scheduledAt,
	}));

	try {
		for (let offset = 0; offset < jobs.length; offset += QUEUE_SEND_LIMIT) {
			await env.INGESTION_QUEUE.sendBatch(
				jobs.slice(offset, offset + QUEUE_SEND_LIMIT).map((body) => ({ body })),
			);
		}
	} catch (error) {
		await Promise.allSettled(jobs.map((job) => (
			runtime.releaseQueueClaim(job.sourceId, job.queueToken, scheduledAt)
		)));
		throw error;
	}

	if (jobs.length > 0) {
		console.info({
			event: 'source_jobs_dispatched',
			count: jobs.length,
			scheduledAt,
		});
	}
	return jobs.length;
}

export async function syncSourceRuntime(
	env: Env,
	scheduledTime = Date.now(),
): Promise<number> {
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	return new SourceRuntimeStateRepository(env.DB).syncActiveSources(scheduledAt);
}

export async function recoverSourceRuntime(
	env: Env,
	config: AppConfig,
	scheduledTime = Date.now(),
): Promise<number> {
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	const runtime = new SourceRuntimeStateRepository(env.DB);
	const count = await runtime.recoverEligibleSources(
		scheduledAt,
		config.ingestion.deadRecoverySeconds,
		config.ingestion.blockedRecoverySeconds,
	);
	if (count > 0) {
		console.info({
			event: 'source_runtime_recovered',
			count,
			scheduledAt,
		});
	}
	return count;
}
