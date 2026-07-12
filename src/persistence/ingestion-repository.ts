import type { CanonicalItem } from '../domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
} from '../ingestion/twitter-api-checkpoint';

export interface ResolvedItemCandidate {
	externalId: string;
	itemId: number;
}

export interface IngestionRepository {
	resolveExistingItems(
		identityNamespace: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
	): Promise<ResolvedItemCandidate[]>;
	upsertItems(
		identityNamespace: string,
		destinationKey: string,
		items: CanonicalItem[],
		now?: number,
		sourceId?: string,
	): Promise<void>;
	observeAndEnsureDeliveries(
		destinationKey: string,
		candidates: ResolvedItemCandidate[],
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
