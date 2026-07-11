import type {
	CanonicalItem,
	IngestionOptions,
	SourceDefinition,
} from '../domain/ingestion';
import { DeliveryRepository } from '../persistence/delivery-repository';
import { SourceAdapterRegistry } from './source-adapter-registry';

export interface SourceIngestionResult {
	sourceId: string;
	sourceKey: string;
	discovered: number;
}

export class IngestionService {
	constructor(
		private readonly repository: DeliveryRepository,
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
			validateBatch(batch, source.sourceId);
			const uniqueItems = deduplicateItems(batch.items);
			const existingIds = await this.repository.findExistingItemIdentities(
				source.identityNamespace,
				uniqueItems,
			);
			const unseenItems = uniqueItems
				.filter((item) => !existingIds.has(item.externalId))
				.sort((left, right) => (left.publishedAt ?? 0) - (right.publishedAt ?? 0));
			const items = batch.itemLimit === null
				? unseenItems
				: unseenItems.slice(0, batch.itemLimit);
			const knownItems = uniqueItems.filter((item) => existingIds.has(item.externalId));
			const deliveryCandidates = batch.itemLimit === null
				? knownItems
				: knownItems.slice(0, batch.itemLimit);

			await this.repository.upsertItems(
				source.identityNamespace,
				source.destinationKey,
				items,
			);
			const routedExisting = await this.repository.ensureDeliveriesForCandidates(
				source.identityNamespace,
				source.destinationKey,
				deliveryCandidates,
			);
			if (batch.checkpoint) {
				await batch.checkpoint.commit(scheduledAt);
			}

			console.info({
				event: 'source_ingested',
				runId,
				sourceId: source.sourceId,
				sourceKey: source.identityNamespace,
				adapterKey: source.adapterKey,
				provider: batch.telemetry.provider,
				discovered: items.length,
				routedExisting,
				paginationComplete: batch.telemetry.paginationComplete,
				paginationStopReason: batch.telemetry.paginationStopReason,
				elapsedMs: Date.now() - startedAt,
			});
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
				sourceId: source.sourceId,
				sourceKey: source.identityNamespace,
				discovered: items.length,
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
): void {
	if (
		batch.itemLimit !== null
		&& (!Number.isInteger(batch.itemLimit) || batch.itemLimit <= 0)
	) {
		throw new Error(`Source ${sourceId} itemLimit must be a positive integer or null`);
	}
	if (batch.checkpoint !== null && batch.itemLimit !== null) {
		throw new Error(`Source ${sourceId} cannot combine itemLimit with a checkpoint`);
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
