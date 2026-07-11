import type {
	IngestionBatch,
	SourceAdapter,
	SourceAdapterContext,
	SourceDefinition,
} from '../domain/ingestion';

interface RegisteredSourceAdapter {
	key: string;
	load(source: SourceDefinition, context: SourceAdapterContext): Promise<IngestionBatch>;
}

export class SourceAdapterRegistry {
	private readonly adapters = new Map<string, RegisteredSourceAdapter>();

	register<TConfig>(adapter: SourceAdapter<TConfig>): this {
		if (!adapter.key.trim()) throw new Error('Source adapter key must not be empty');
		if (this.adapters.has(adapter.key)) {
			throw new Error(`Source adapter already registered: ${adapter.key}`);
		}

		this.adapters.set(adapter.key, {
			key: adapter.key,
			load: (source, context) => adapter.load({
				...source,
				config: adapter.decodeConfig(source.config),
			}, context),
		});
		return this;
	}

	async load(
		source: SourceDefinition,
		context: SourceAdapterContext,
	): Promise<IngestionBatch> {
		validateSourceDefinition(source);
		const adapter = this.adapters.get(source.adapterKey);
		if (!adapter) {
			throw new Error(
				`Unknown source adapter ${source.adapterKey} for source ${source.sourceId}`,
			);
		}
		return adapter.load(source, context);
	}
}

export function validateSourceDefinition(source: SourceDefinition): void {
	assertNonEmpty(source.sourceId, 'sourceId');
	assertNonEmpty(source.adapterKey, 'adapterKey');
	assertNonEmpty(source.identityNamespace, 'identityNamespace');
	assertNonEmpty(source.destinationKey, 'destinationKey');
	if (!Number.isInteger(source.pollEveryMinutes) || source.pollEveryMinutes <= 0) {
		throw new Error(
			`Source ${source.sourceId} pollEveryMinutes must be a positive integer`,
		);
	}
}

function assertNonEmpty(value: string, name: string): void {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Source ${name} must not be empty`);
	}
}
