export interface CanonicalItem {
	externalId: string;
	identityAliases?: string[];
	title: string | null;
	description: string | null;
	link: string | null;
	author: string | null;
	imageUrl: string | null;
	publishedAt: number | null;
	metadata?: Record<string, unknown>;
}

export interface SourceDefinition<TConfig = unknown> {
	sourceId: string;
	adapterKey: string;
	identityNamespace: string;
	destinationKey: string;
	pollEveryMinutes: number;
	config: TConfig;
}

export interface SourceCatalog {
	list(): Promise<SourceDefinition[]>;
}

export interface IngestionOptions {
	feedTimeoutMs: number;
	maxFeedBytes: number;
	maxItemsPerSource: number;
}

export interface SourceAdapterContext {
	options: IngestionOptions;
	runId: string;
	scheduledAt: number;
}

export interface IngestionTelemetry {
	provider: string;
	paginationComplete?: boolean;
	paginationStopReason?: string;
	initialization?: Record<string, unknown>;
}

export interface IngestionCheckpointCommit {
	commit(updatedAt: number): Promise<void>;
}

interface IngestionBatchBase {
	items: CanonicalItem[];
	telemetry: IngestionTelemetry;
}

export type IngestionBatch = IngestionBatchBase & (
	| {
		itemLimit: null;
		checkpoint: IngestionCheckpointCommit | null;
	}
	| {
		itemLimit: number;
		checkpoint: null;
	}
);

export interface SourceAdapter<TConfig = unknown> {
	readonly key: string;
	decodeConfig(config: unknown): TConfig;
	load(
		source: SourceDefinition<TConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch>;
}
