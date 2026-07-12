import type { AppConfig } from '../config';
import type { IngestionJob } from '../domain/ingestion';
import { DeliveryRepository } from '../persistence/delivery-repository';
import { SourceRuntimeStateRepository } from '../persistence/source-runtime-state-repository';
import { IngestionService } from './ingestion-service';
import { defaultSourceAdapterRegistry, validateRuntimeTopology } from './ingest-sources';
import { D1SourceCatalog } from './source-catalog';
import { SourceIngestionLimitError } from './source-ingestion-limit-error';
import { SourceHttpError } from './source-http-error';

const MAX_DELAY_SECONDS = 86_400;

export async function consumeIngestionBatch(
	batch: MessageBatch<IngestionJob>,
	env: Env,
	config: AppConfig,
): Promise<void> {
	const deliveryRepository = new DeliveryRepository(env.DB);
	const runtime = new SourceRuntimeStateRepository(env.DB);
	const catalog = new D1SourceCatalog(env.DB, config);
	const sources = await catalog.list();
	validateRuntimeTopology(config, sources);
	const sourcesById = new Map(sources.map((source) => [source.sourceId, source]));
	const service = new IngestionService(
		deliveryRepository,
		defaultSourceAdapterRegistry(deliveryRepository),
	);

	for (const message of batch.messages) {
		if (!isIngestionJob(message.body)) {
			console.error({ event: 'invalid_ingestion_job', queueMessageId: message.id });
			message.ack();
			continue;
		}

		const job = message.body;
		const source = sourcesById.get(job.sourceId);
		if (!source) {
			console.warn({ event: 'stale_ingestion_job_source_missing', sourceId: job.sourceId });
			message.ack();
			continue;
		}

		const now = currentUnixTime();
		const leaseToken = crypto.randomUUID();
		const acquired = await runtime.acquireQueuedLease(
			job.sourceId,
			job.queueToken,
			leaseToken,
			now,
			config.ingestion.leaseSeconds,
		);
		if (!acquired) {
			await handleUnavailableJob(message, runtime, job, now);
			continue;
		}

		try {
			const result = await service.ingest(
				source,
				config.ingestion,
				now,
				job.queueToken,
			);
			const marked = await runtime.markSucceeded(
				job.sourceId,
				leaseToken,
				now + source.pollEveryMinutes * 60,
				now,
			);
			if (!marked) throw new Error(`Lost source runtime lease for ${job.sourceId}`);

			console.info({
				event: 'source_job_succeeded',
				sourceId: job.sourceId,
				discovered: result.discovered,
				queueMessageId: message.id,
			});
			message.ack();
		} catch (error) {
			await handleIngestionFailure(
				message,
				runtime,
				job,
				leaseToken,
				error,
				now,
				config.ingestion.queueClaimSeconds,
			);
		}
	}

}

export async function consumeIngestionDeadLetterBatch(
	batch: MessageBatch<IngestionJob>,
	env: Env,
): Promise<void> {
	const runtime = new SourceRuntimeStateRepository(env.DB);
	for (const message of batch.messages) {
		if (!isIngestionJob(message.body)) {
			console.error({ event: 'invalid_ingestion_dead_letter_job', queueMessageId: message.id });
			message.ack();
			continue;
		}

		const now = currentUnixTime();
		const reconciled = await runtime.reconcileDeadLetter(
			message.body.sourceId,
			message.body.queueToken,
			now,
		);
		if (!reconciled) {
			const state = await runtime.get(message.body.sourceId);
			if (state?.status === 'running' && state.leaseExpiresAt && state.leaseExpiresAt > now) {
				message.retry({ delaySeconds: clampDelay(state.leaseExpiresAt - now) });
				continue;
			}
			message.ack();
			continue;
		}

		console.error({
			event: 'source_reconciled_from_dlq',
			sourceId: message.body.sourceId,
			queueMessageId: message.id,
		});
		message.ack();
	}
}

async function handleUnavailableJob(
	message: Message<IngestionJob>,
	runtime: SourceRuntimeStateRepository,
	job: IngestionJob,
	now: number,
): Promise<void> {
	const state = await runtime.get(job.sourceId);
	if (
		state?.status === 'queued'
		&& state.queueToken === job.queueToken
		&& state.nextPollAt > now
	) {
		message.retry({ delaySeconds: clampDelay(state.nextPollAt - now) });
		return;
	}
	if (state?.status === 'running' && state.leaseExpiresAt && state.leaseExpiresAt > now) {
		message.retry({ delaySeconds: clampDelay(state.leaseExpiresAt - now) });
		return;
	}
	message.ack();
}

async function handleIngestionFailure(
	message: Message<IngestionJob>,
	runtime: SourceRuntimeStateRepository,
	job: IngestionJob,
	leaseToken: string,
	error: unknown,
	now: number,
	claimSeconds: number,
): Promise<void> {
	const details = ingestionErrorDetails(error);
	if (details.permanent) {
		const marked = await runtime.markBlocked(
			job.sourceId,
			leaseToken,
			details.code,
			details.message,
			now,
		);
		if (!marked) throw new Error(`Failed to mark source ${job.sourceId} blocked`);
		console.error({
			event: 'source_job_blocked',
			sourceId: job.sourceId,
			errorCode: details.code,
			error: details.message,
		});
		message.ack();
		return;
	}

	const delaySeconds = ingestionRetryDelaySeconds(
		message.attempts,
		details.retryAfterSeconds,
	);
	const retryAt = now + delaySeconds;
	const marked = await runtime.scheduleQueueRetry(
		job.sourceId,
		leaseToken,
		job.queueToken,
		retryAt,
		retryAt + claimSeconds,
		details.code,
		details.message,
		now,
	);
	if (!marked) throw new Error(`Failed to schedule source retry for ${job.sourceId}`);
	console.error({
		event: 'source_job_retry',
		sourceId: job.sourceId,
		attempt: message.attempts,
		delaySeconds,
		errorCode: details.code,
		error: details.message,
	});
	message.retry({ delaySeconds });
}

export function ingestionRetryDelaySeconds(
	attempt: number,
	retryAfterSeconds: number | null,
	random = Math.random,
): number {
	const exponential = Math.min(3_600, 30 * 2 ** Math.max(0, attempt - 1));
	const jittered = exponential + exponential * 0.25 * random();
	return clampDelay(Math.max(retryAfterSeconds ?? 0, jittered));
}

function ingestionErrorDetails(error: unknown): {
	code: string;
	message: string;
	permanent: boolean;
	retryAfterSeconds: number | null;
} {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof SourceIngestionLimitError) {
		return {
			code: error.code,
			message,
			permanent: true,
			retryAfterSeconds: null,
		};
	}
	if (!(error instanceof SourceHttpError)) {
		return {
			code: 'UNEXPECTED_INGESTION_ERROR',
			message,
			permanent: false,
			retryAfterSeconds: null,
		};
	}
	const permanent = error.status >= 400
		&& error.status < 500
		&& ![408, 425, 429].includes(error.status);
	return {
		code: `SOURCE_HTTP_${error.status}`,
		message,
		permanent,
		retryAfterSeconds: error.retryAfterSeconds,
	};
}

function isIngestionJob(value: unknown): value is IngestionJob {
	if (!value || typeof value !== 'object') return false;
	const job = value as Partial<IngestionJob>;
	return job.version === 1
		&& typeof job.sourceId === 'string'
		&& Boolean(job.sourceId.trim())
		&& typeof job.queueToken === 'string'
		&& Boolean(job.queueToken.trim())
		&& Number.isSafeInteger(job.scheduledAt)
		&& Number(job.scheduledAt) >= 0;
}

function clampDelay(value: number): number {
	return Math.min(MAX_DELAY_SECONDS, Math.max(1, Math.ceil(value)));
}

function currentUnixTime(): number {
	return Math.floor(Date.now() / 1_000);
}
