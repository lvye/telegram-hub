import { normalizeDestinationKey, type AppConfig } from '../config';
import type { SourceDefinition } from '../domain/ingestion';
import type { IngestionRepository } from '../persistence/ingestion-repository';
import { D1TwitterApiIoCheckpointStore } from '../persistence/source-checkpoint-store';
import { RssSourceAdapter } from './rss-source-adapter';
import {
	SourceAdapterRegistry,
	validateSourceDefinition,
} from './source-adapter-registry';
import { NitterUserSourceAdapter } from './nitter-source-adapter';
import { TwitterApiIoUserSourceAdapter } from './twitter-api-source-adapter';

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
