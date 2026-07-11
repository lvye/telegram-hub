import type { CanonicalItem } from '../domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
} from '../ingestion/twitter-api-checkpoint';

export interface IngestionRepository {
	findExistingItemIdentities(
		identityNamespace: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
	): Promise<Set<string>>;
	upsertItems(
		identityNamespace: string,
		destinationKey: string,
		items: CanonicalItem[],
		now?: number,
		sourceId?: string,
	): Promise<void>;
	ensureDeliveriesForCandidates(
		identityNamespace: string,
		destinationKey: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
		now?: number,
		sourceId?: string,
	): Promise<number>;
	getOrCreateSourceProviderState(
		identityNamespace: string,
		checkpointKey: string,
		fallbackInitializedAt: number,
		overlapSeconds?: number,
		bootstrapUserName?: string | null,
	): Promise<TwitterApiIoCheckpoint>;
	updateSourceIngestionProgress(
		identityNamespace: string,
		checkpointKey: string,
		previous: TwitterApiIoCheckpoint,
		progress: TwitterApiIoCheckpointProgress,
		now?: number,
	): Promise<void>;
}
