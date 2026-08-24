export interface TwitterApiIoCheckpoint {
	highWaterExternalId: string | null;
	initializedAt: number;
	lastSuccessfulPollAt: number | null;
	nextCursor: string | null;
	pendingHighWaterExternalId: string | null;
}

export interface TwitterApiIoCheckpointProgress {
	highWaterExternalId: string | null;
	nextCursor: string | null;
	pendingHighWaterExternalId: string | null;
}

export interface TwitterApiIoCheckpointRequest {
	identityNamespace: string;
	checkpointKey: string;
	fallbackInitializedAt: number;
	overlapSeconds: number;
	bootstrapUserName: string | null;
}

export interface TwitterApiIoCheckpointStore {
	getOrCreate(request: TwitterApiIoCheckpointRequest): Promise<TwitterApiIoCheckpoint>;
	commit(
		identityNamespace: string,
		checkpointKey: string,
		previous: TwitterApiIoCheckpoint,
		progress: TwitterApiIoCheckpointProgress,
		updatedAt: number,
	): Promise<void>;
}

export interface SourceProviderMetadataStore {
	getMetadata(sourceId: string): Promise<Record<string, unknown>>;
	mergeMetadata(
		sourceId: string,
		metadata: Record<string, unknown>,
		updatedAt: number,
	): Promise<void>;
}
