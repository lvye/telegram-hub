import type {
	CanonicalItem,
	IngestionBatch,
	IngestionOptions,
	SourceDefinition,
} from '../domain/ingestion';
import type { IngestionRepository } from '../persistence/ingestion-repository';
import { SourceAdapterRegistry } from './source-adapter-registry';
import { SourceIngestionLimitError } from './source-ingestion-limit-error';

export interface SourceIngestionResult {
	discovered: number;
	routedExisting: number;
}

export class IngestionService {
	constructor(
		private readonly repository: IngestionRepository,
		private readonly adapters: SourceAdapterRegistry,
	) {}

	async ingest(
		source: SourceDefinition,
		options: IngestionOptions,
		scheduledAt: number,
		runId: string,
	): Promise<SourceIngestionResult> {
		const startedAt = Date.now();
		try {
			const batch = await this.adapters.load(source, {
				options,
				runId,
				scheduledAt,
			});
			await this.repository.recordProviderUsage(
				source.sourceId,
				batch.telemetry.usage ?? [],
				scheduledAt,
			);
			validateBatch(batch, source.sourceId, options.maxItemsPerSource);
			if (batch.items.length > options.maxCandidatesPerSource) {
				throw SourceIngestionLimitError.candidates(
					source.sourceId,
					batch.items.length,
					options.maxCandidatesPerSource,
				);
			}
			const uniqueItems = deduplicateItems(batch.items);
			const identityAliases = new Set(uniqueItems.flatMap((item) => [
				item.externalId,
				...(item.identityAliases ?? []),
			]));
			if (identityAliases.size > options.maxIdentityAliasesPerSource) {
				throw SourceIngestionLimitError.aliases(
					source.sourceId,
					identityAliases.size,
					options.maxIdentityAliasesPerSource,
				);
			}
			const resolvedItems = await this.repository.resolveExistingItems(
				source.identityNamespace,
				uniqueItems,
			);
			const resolvedByExternalId = new Map(resolvedItems.map((item) => [
				item.externalId,
				item,
			]));
			const unseenItems = uniqueItems
				.filter((item) => !resolvedByExternalId.has(item.externalId))
				.sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0));
			const items = unseenItems.slice(0, batch.itemLimit);
			const knownItems = uniqueItems.filter((item) => (
				resolvedByExternalId.has(item.externalId)
			));
			const resolvedDeliveryCandidates = knownItems.flatMap((item) => {
				const resolved = resolvedByExternalId.get(item.externalId);
				return resolved ? [resolved] : [];
			});

			await this.repository.upsertItems(
				source.identityNamespace,
				source.destinationKey,
				items,
				scheduledAt,
				source.sourceId,
			);
			const routedExisting = await this.repository.observeAndEnsureDeliveries(
				source.destinationKey,
				resolvedDeliveryCandidates,
				scheduledAt,
				source.sourceId,
			);
			const remainingUnseen = unseenItems.length - items.length;
			let checkpointCommitted = false;
			if (batch.checkpoint && remainingUnseen === 0) {
				await batch.checkpoint.commit(scheduledAt);
				checkpointCommitted = true;
			}

			if (
				items.length > 0
				|| remainingUnseen > 0
				|| routedExisting > 0
				|| batch.telemetry.paginationComplete === false
			) {
				console.info({
					event: 'source_ingested',
					runId,
					sourceId: source.sourceId,
					sourceKey: source.identityNamespace,
					adapterKey: source.adapterKey,
					provider: batch.telemetry.provider,
					discovered: items.length,
					remainingUnseen,
					routedExisting,
					checkpointCommitted,
					paginationComplete: batch.telemetry.paginationComplete,
					paginationStopReason: batch.telemetry.paginationStopReason,
					providerRequestCount: sumUsage(batch.telemetry.usage, 'requestCount'),
					providerResourceCount: sumUsage(batch.telemetry.usage, 'resourceCount'),
					providerEstimatedCostUsdMicros: estimatedCostUsdMicros(
						batch.telemetry.usage,
					),
					elapsedMs: Date.now() - startedAt,
				});
			}
			if (batch.telemetry.initialization) {
				console.info({
					event: 'source_provider_initialized',
					runId,
					sourceId: source.sourceId,
					sourceKey: source.identityNamespace,
					adapterKey: source.adapterKey,
					provider: batch.telemetry.provider,
					...batch.telemetry.initialization,
				});
			}

			return {
				discovered: items.length,
				routedExisting,
			};
		} catch (error) {
			console.error({
				event: 'source_ingestion_failed',
				runId,
				sourceId: source.sourceId,
				sourceKey: source.identityNamespace,
				adapterKey: source.adapterKey,
				elapsedMs: Date.now() - startedAt,
				error: errorMessage(error),
			});
			throw error;
		}
	}
}

function validateBatch(
	batch: Awaited<ReturnType<SourceAdapterRegistry['load']>>,
	sourceId: string,
	maxItemsPerSource: number,
): void {
	if (!Number.isInteger(batch.itemLimit) || batch.itemLimit <= 0) {
		throw new Error(`Source ${sourceId} itemLimit must be a positive integer`);
	}
	if (batch.itemLimit > maxItemsPerSource) {
		throw new Error(
			`Source ${sourceId} itemLimit ${batch.itemLimit} exceeds configured maximum `
			+ maxItemsPerSource,
		);
	}
}

function deduplicateItems(items: CanonicalItem[]): CanonicalItem[] {
	const unique: CanonicalItem[] = [];
	const seenAliases = new Set<string>();
	for (const item of items) {
		const aliases = [item.externalId, ...(item.identityAliases ?? [])];
		if (aliases.some((alias) => seenAliases.has(alias))) continue;
		unique.push(item);
		for (const alias of aliases) seenAliases.add(alias);
	}

	return unique;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sumUsage(
	usage: IngestionBatch['telemetry']['usage'],
	key: 'requestCount' | 'resourceCount',
): number {
	return (usage ?? []).reduce((sum, entry) => sum + entry[key], 0);
}

function estimatedCostUsdMicros(usage: IngestionBatch['telemetry']['usage']): number {
	return (usage ?? []).reduce((sum, entry) => (
		sum + entry.billableUnitCount * entry.unitPriceUsdMicros
	), 0);
}
