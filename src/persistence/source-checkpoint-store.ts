import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
	TwitterApiIoCheckpointRequest,
	TwitterApiIoCheckpointStore,
} from '../ingestion/twitter-api-checkpoint';
import { DeliveryRepository } from './delivery-repository';

export class D1TwitterApiIoCheckpointStore implements TwitterApiIoCheckpointStore {
	constructor(private readonly repository: DeliveryRepository) {}

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
}
