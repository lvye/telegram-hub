import type { AppConfig } from '../config';
import type { SourceCatalog, SourceDefinition } from '../domain/ingestion';
import { DeliveryRepository } from '../persistence/delivery-repository';
import { D1TwitterApiIoCheckpointStore } from '../persistence/source-checkpoint-store';
import { IngestionService, type SourceIngestionResult } from './ingestion-service';
import { RssSourceAdapter } from './rss-source-adapter';
import {
	SourceAdapterRegistry,
	validateSourceDefinition,
} from './source-adapter-registry';
import { D1SourceCatalog } from './source-catalog';
import { TwitterApiIoUserSourceAdapter } from './twitter-api-source-adapter';

export type { SourceIngestionResult } from './ingestion-service';

export interface IngestionRuntimeDependencies {
	catalog?: SourceCatalog;
	registry?: SourceAdapterRegistry;
}

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
	const dueSources = sources.filter((source) => isSourceDue(source, scheduledTime));
	const results = await Promise.allSettled(
		dueSources.map((source) => service.ingest(
			source,
			config.ingestion,
			scheduledAt,
			runId,
		)),
	);
	const failures: unknown[] = [];
	const completed: SourceIngestionResult[] = [];

	for (const result of results) {
		if (result.status === 'fulfilled') {
			completed.push(result.value);
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
		if (destinationKeys.has(destination.destinationKey)) {
			throw new Error(`Duplicate destination ${destination.destinationKey}`);
		}
		destinationKeys.add(destination.destinationKey);
	}

	const sourceIds = new Set<string>();
	for (const source of sources) {
		validateSourceDefinition(source);
		if (sourceIds.has(source.sourceId)) {
			throw new Error(`Duplicate source ${source.sourceId}`);
		}
		sourceIds.add(source.sourceId);
		if (!destinationKeys.has(source.destinationKey)) {
			throw new Error(
				`Unknown destination ${source.destinationKey} for source ${source.sourceId}`,
			);
		}
	}
}

export function defaultSourceAdapterRegistry(
	repository: DeliveryRepository,
): SourceAdapterRegistry {
	return new SourceAdapterRegistry()
		.register(new RssSourceAdapter())
		.register(new TwitterApiIoUserSourceAdapter(
			new D1TwitterApiIoCheckpointStore(repository),
		));
}
