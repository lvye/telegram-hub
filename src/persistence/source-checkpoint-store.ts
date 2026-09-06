import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointRequest,
	TwitterApiIoCheckpointStore,
	SourceProviderMetadataStore,
} from '../ingestion/twitter-api-checkpoint';
import type { IngestionRepository } from './ingestion-repository';

export class D1TwitterApiIoCheckpointStore implements TwitterApiIoCheckpointStore, SourceProviderMetadataStore {
	constructor(private readonly repository: IngestionRepository) {}

	getOrCreate(request: TwitterApiIoCheckpointRequest): Promise<TwitterApiIoCheckpoint> {
		return this.repository.getOrCreateSourceProviderState(
			request.identityNamespace,
			request.checkpointKey,
			request.fallbackInitializedAt,
			request.overlapSeconds,
			request.bootstrapUserName,
		);
	}

	commit(
		identityNamespace: string,
		checkpointKey: string,
		previous: TwitterApiIoCheckpoint,
		progress: TwitterApiIoCheckpointProgress,
		updatedAt: number,
	): Promise<void> {
		return this.repository.updateSourceIngestionProgress(
			identityNamespace,
			checkpointKey,
			previous,
			progress,
			updatedAt,
		);
	}

	getMetadata(sourceId: string): Promise<Record<string, unknown>> {
		return this.repository.getSourceProviderMetadata(sourceId);
	}

	mergeMetadata(
		sourceId: string,
		metadata: Record<string, unknown>,
		updatedAt: number,
	): Promise<void> {
		return this.repository.mergeSourceProviderMetadata(sourceId, metadata, updatedAt);
	}
}
