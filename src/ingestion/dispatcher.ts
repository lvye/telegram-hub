import type { AppConfig } from '../config';
import type { IngestionJob } from '../domain/ingestion';
import { SourceRuntimeStateRepository } from '../persistence/source-runtime-state-repository';
import { validateRuntimeTopology } from './ingest-sources';
import { D1SourceCatalog } from './source-catalog';

const QUEUE_SEND_LIMIT = 100;

export async function dispatchDueSources(
	env: Env,
	config: AppConfig,
	scheduledTime = Date.now(),
): Promise<number> {
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	const catalog = new D1SourceCatalog(env.DB, config);
	const sources = await catalog.list();
	validateRuntimeTopology(config, sources);
	const runtime = new SourceRuntimeStateRepository(env.DB);
	await runtime.syncSources(sources, scheduledAt);
	const [deadRecovered, blockedRecovered] = await Promise.all([
		runtime.recoverDeadSources(scheduledAt, config.ingestion.deadRecoverySeconds),
		runtime.recoverBlockedSources(scheduledAt, config.ingestion.blockedRecoverySeconds),
	]);

	const dueSourceIds = await runtime.listDueSourceIds(scheduledAt, QUEUE_SEND_LIMIT);
	const jobs: IngestionJob[] = [];
	for (const sourceId of dueSourceIds) {
		const queueToken = crypto.randomUUID();
		if (await runtime.claimForQueue(
			sourceId,
			queueToken,
			scheduledAt,
			config.ingestion.queueClaimSeconds,
		)) {
			jobs.push({ version: 1, sourceId, queueToken, scheduledAt });
		}
	}

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

	console.info({
		event: 'source_jobs_dispatched',
		count: jobs.length,
		deadRecovered,
		blockedRecovered,
		scheduledAt,
	});
	return jobs.length;
}
