import type {
	AppConfig,
	NitterUserAdapterConfig,
	RssSourceAdapterConfig,
	TwitterApiIoUserAdapterConfig,
} from '../config';
import type { SourceCatalog, SourceDefinition } from '../domain/ingestion';
import { NITTER_USER_ADAPTER_KEY } from './nitter-source-adapter';
import { RSS_SOURCE_ADAPTER_KEY } from './rss-source-adapter';
import { TWITTER_API_IO_USER_ADAPTER_KEY } from './twitter-api-source-adapter';

interface ConnectorRow {
	source_id: string;
	adapter_key: string;
	identity_namespace: string;
	destination_key: string;
	poll_interval_seconds: number;
	provider_key: string;
	config_json: string;
	initialized_at: number;
}

export class D1SourceCatalog implements SourceCatalog {
	constructor(
		private readonly db: D1Database,
		private readonly config: AppConfig,
	) {}

	async get(sourceId: string): Promise<SourceDefinition | null> {
		const result = await this.db.prepare(`${sourceCatalogSelect()}
				AND connectors.connector_key = ?
			ORDER BY destinations.destination_key
		`).bind(sourceId).all<ConnectorRow>();
		if (result.results.length > 1) {
			throw new Error(`Duplicate source ${sourceId}`);
		}
		const row = result.results[0];
		return row ? this.sourceDefinition(row) : null;
	}

	async list(): Promise<SourceDefinition[]> {
		const result = await this.db.prepare(`${sourceCatalogSelect()}
			ORDER BY connectors.connector_key, destinations.destination_key
		`).all<ConnectorRow>();

		return result.results.map((row) => this.sourceDefinition(row));
	}

	private sourceDefinition(row: ConnectorRow): SourceDefinition {
		if (row.poll_interval_seconds % 60 !== 0) {
			throw new Error(`Connector ${row.source_id} poll interval must use whole minutes`);
		}
		const base = {
			sourceId: row.source_id,
			adapterKey: row.adapter_key,
			identityNamespace: row.identity_namespace,
			destinationKey: row.destination_key,
			pollEveryMinutes: row.poll_interval_seconds / 60,
		};
		const stored = jsonObject(row.config_json, `connector ${row.source_id}`);

		if (row.adapter_key === RSS_SOURCE_ADAPTER_KEY) {
			return {
				...base,
				config: {
					url: requiredString(stored.url, 'url', row.source_id),
					parser: requiredString(stored.parser, 'parser', row.source_id),
					identityStrategy: requiredString(
						stored.identityStrategy,
						'identityStrategy',
						row.source_id,
					),
				} as RssSourceAdapterConfig,
			};
		}
		if (row.adapter_key === NITTER_USER_ADAPTER_KEY) {
			const userName = requiredString(stored.userName, 'userName', row.source_id);
			const baseUrl = requiredString(stored.baseUrl, 'baseUrl', row.source_id);
			return {
				...base,
				config: {
					feedUrl: nitterFeedUrl(baseUrl, userName),
					userName,
					includeReplies: Boolean(stored.includeReplies),
					providerStateKey: row.source_id,
					initializationAt: row.initialized_at,
				} satisfies NitterUserAdapterConfig,
			};
		}
		if (row.adapter_key === TWITTER_API_IO_USER_ADAPTER_KEY) {
			if (!this.config.twitterApiIo.apiKey) {
				throw new Error(`Connector ${row.source_id} requires TWITTERAPI_IO_API_KEY`);
			}
			return {
				...base,
				config: {
					apiKey: this.config.twitterApiIo.apiKey,
					bootstrapUserName: optionalString(stored.userName) ?? undefined,
					endpoint: requiredString(stored.endpoint, 'endpoint', row.source_id),
					fallback: null,
					includeReplies: Boolean(stored.includeReplies),
					initializationAt: row.initialized_at,
					maxPages: requiredInteger(stored.maxPages, 'maxPages', row.source_id),
					providerStateKey: row.source_id,
					userId: optionalString(stored.userId),
					userName: optionalString(stored.userName),
				} satisfies TwitterApiIoUserAdapterConfig,
			};
		}
		throw new Error(
			`Unsupported v2 connector ${row.source_id}: ${row.provider_key}/${row.adapter_key}`,
		);
	}
}

function sourceCatalogSelect(): string {
	return `
		SELECT
			connectors.connector_key AS source_id,
			connectors.adapter_key,
			sources.identity_namespace,
			destinations.destination_key,
			connectors.poll_interval_seconds,
			connectors.provider_key,
			connectors.config_json,
			COALESCE(checkpoints.initialized_at, sources.created_at) AS initialized_at
		FROM source_connectors AS connectors
		JOIN sources ON sources.id = connectors.source_id
		JOIN source_routes AS routes ON routes.source_id = sources.id
		JOIN destinations ON destinations.id = routes.destination_id
		LEFT JOIN source_connector_checkpoints AS checkpoints
			ON checkpoints.connector_id = connectors.id
		WHERE connectors.status = 'active'
			AND sources.status = 'active'
			AND routes.status = 'active'
			AND destinations.status = 'active'
	`;
}

function nitterFeedUrl(baseUrl: string, userName: string): string {
	const base = new URL(baseUrl);
	if (!base.pathname.endsWith('/')) base.pathname += '/';
	return new URL(`${encodeURIComponent(userName)}/rss`, base).toString();
}

function jsonObject(value: string, name: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(`${name} config_json must be an object`);
	}
	return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, sourceId: string): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new Error(`Connector ${sourceId} ${name} must be a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredInteger(value: unknown, name: string, sourceId: string): number {
	if (!Number.isInteger(value) || Number(value) <= 0) {
		throw new Error(`Connector ${sourceId} ${name} must be a positive integer`);
	}
	return Number(value);
}
