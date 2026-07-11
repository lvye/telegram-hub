import { normalizeDestinationKey, type AppConfig } from '../config';
import type { SourceCatalog, SourceDefinition } from '../domain/ingestion';
import { DeliveryRepository } from '../persistence/delivery-repository';
import type { IngestionRepository } from '../persistence/ingestion-repository';
import { D1TwitterApiIoCheckpointStore } from '../persistence/source-checkpoint-store';
import { SourceRuntimeStateRepository } from '../persistence/source-runtime-state-repository';
import { IngestionService, type SourceIngestionResult } from './ingestion-service';
import { RssSourceAdapter } from './rss-source-adapter';
import {
	SourceAdapterRegistry,
	validateSourceDefinition,
} from './source-adapter-registry';
import { D1SourceCatalog } from './source-catalog';
import { NitterUserSourceAdapter } from './nitter-source-adapter';
import { TwitterApiIoUserSourceAdapter } from './twitter-api-source-adapter';

export type { SourceIngestionResult } from './ingestion-service';

export interface IngestionRuntimeDependencies {
	catalog?: SourceCatalog;
	registry?: SourceAdapterRegistry;
}

const SOURCE_LEASE_SECONDS = 5 * 60;

export async function ingestSources(
	env: Env,
	config: AppConfig,
	scheduledTime = Date.now(),
	dependencies: IngestionRuntimeDependencies = {},
): Promise<SourceIngestionResult[]> {
	const repository = new DeliveryRepository(env.DB);
	const scheduledAt = Math.floor(scheduledTime / 1_000);
	const runId = crypto.randomUUID();
	const catalog = dependencies.catalog ?? new D1SourceCatalog(env.DB, config);
	const registry = dependencies.registry ?? defaultSourceAdapterRegistry(repository);
	const service = new IngestionService(repository, registry);
	const sources = await catalog.list();
	validateRuntimeTopology(config, sources);
	const runtimeState = new SourceRuntimeStateRepository(env.DB);
	await runtimeState.syncSources(sources, scheduledAt);
	const dueSources = sources.filter((source) => isSourceDue(source, scheduledTime));
	const results = await Promise.allSettled(
		dueSources.map((source) => ingestSourceWithLease(
			source,
			service,
			runtimeState,
			config,
			scheduledAt,
			runId,
		)),
	);
	const failures: unknown[] = [];
	const completed: SourceIngestionResult[] = [];

	for (const result of results) {
		if (result.status === 'fulfilled') {
			if (result.value) completed.push(result.value);
		} else {
			failures.push(result.reason);
		}
	}

	// Recover expired leases before reconciliation so only genuinely active
	// sends can defer a legacy outcome/cursor. This runs every minute; the daily
	// cleanup remains a second safety net for abandoned queued work.
	await repository.recoverStaleDeliveries();

	// Run immediately before dispatch, after the slower feed fetches. This
	// catches legacy claims made during the migration/deploy overlap and can
	// safely block a colliding ready/queued delivery before it is sent.
	await repository.reconcileLegacyRows();

	if (failures.length > 0) {
		throw new AggregateError(failures, `Failed to ingest ${failures.length} source(s)`);
	}

	return completed;
}

async function ingestSourceWithLease(
	source: SourceDefinition,
	service: IngestionService,
	runtimeState: SourceRuntimeStateRepository,
	config: AppConfig,
	scheduledAt: number,
	runId: string,
): Promise<SourceIngestionResult | null> {
	const leaseToken = crypto.randomUUID();
	const acquired = await runtimeState.acquireLease(
		source.sourceId,
		leaseToken,
		scheduledAt,
		SOURCE_LEASE_SECONDS,
	);
	if (!acquired) {
		console.warn({
			event: 'source_runtime_lease_busy',
			runId,
			sourceId: source.sourceId,
			adapterKey: source.adapterKey,
		});
		return null;
	}

	const nextPollAt = scheduledAt + source.pollEveryMinutes * 60;
	let result: SourceIngestionResult;
	try {
		result = await service.ingest(source, config.ingestion, scheduledAt, runId);
	} catch (error) {
		let recorded: boolean;
		try {
			recorded = await runtimeState.markFailed(
				source.sourceId,
				leaseToken,
				nextPollAt,
				'SOURCE_INGESTION_FAILED',
				errorMessage(error),
				scheduledAt,
			);
		} catch (stateError) {
			throw new AggregateError(
				[error, stateError],
				`Failed to ingest and record runtime state for ${source.sourceId}`,
			);
		}
		if (!recorded) {
			throw new AggregateError(
				[error, new Error(`Lost source runtime lease for ${source.sourceId}`)],
				`Failed to ingest and record runtime state for ${source.sourceId}`,
			);
		}
		throw error;
	}

	const recorded = await runtimeState.markSucceeded(
		source.sourceId,
		leaseToken,
		nextPollAt,
		scheduledAt,
	);
	if (!recorded) {
		throw new Error(`Lost source runtime lease for ${source.sourceId}`);
	}
	return result;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isSourceDue(source: SourceDefinition, scheduledTime: number): boolean {
	const minute = Math.floor(scheduledTime / 60_000);
	return minute % source.pollEveryMinutes === 0;
}

export function validateRuntimeTopology(
	config: AppConfig,
	sources: SourceDefinition[],
): void {
	const destinationKeys = new Set<string>();
	for (const destination of config.destinations) {
		if (!destination.destinationKey.trim()) {
			throw new Error('Destination key must not be empty');
		}
		if (destinationKeys.has(normalizeDestinationKey(destination.destinationKey))) {
			throw new Error(`Duplicate destination ${destination.destinationKey}`);
		}
		destinationKeys.add(normalizeDestinationKey(destination.destinationKey));
	}

	const sourceIds = new Set<string>();
	for (const source of sources) {
		validateSourceDefinition(source);
		if (sourceIds.has(source.sourceId)) {
			throw new Error(`Duplicate source ${source.sourceId}`);
		}
		sourceIds.add(source.sourceId);
		if (!destinationKeys.has(normalizeDestinationKey(source.destinationKey))) {
			throw new Error(
				`Unknown destination ${source.destinationKey} for source ${source.sourceId}`,
			);
		}
	}
}

export function defaultSourceAdapterRegistry(
	repository: IngestionRepository,
): SourceAdapterRegistry {
	const checkpoints = new D1TwitterApiIoCheckpointStore(repository);
	return new SourceAdapterRegistry()
		.register(new RssSourceAdapter())
		.register(new NitterUserSourceAdapter(checkpoints))
		.register(new TwitterApiIoUserSourceAdapter(checkpoints));
}
