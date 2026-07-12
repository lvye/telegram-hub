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
	get(sourceId: string): Promise<SourceDefinition | null>;
	list(): Promise<SourceDefinition[]>;
}

export interface IngestionJob {
	version: 1;
	sourceId: string;
	queueToken: string;
	scheduledAt: number;
}

export interface IngestionOptions {
	feedTimeoutMs: number;
	maxFeedBytes: number;
	maxCandidatesPerSource: number;
	maxIdentityAliasesPerSource: number;
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

export interface IngestionBatch {
	items: CanonicalItem[];
	/** Maximum unseen items to persist in this run. */
	itemLimit: number;
	/** Committed only after every unseen item in this batch has been persisted. */
	checkpoint: IngestionCheckpointCommit | null;
	telemetry: IngestionTelemetry;
}

export interface SourceAdapter<TConfig = unknown> {
	readonly key: string;
	decodeConfig(config: unknown): TConfig;
	load(
		source: SourceDefinition<TConfig>,
		context: SourceAdapterContext,
	): Promise<IngestionBatch>;
}
