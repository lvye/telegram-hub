import type { AppConfig, RssSourceConfig } from '../config';

const PAGE_SIZE = 100;
const STATEMENT_BATCH_SIZE = 40;

interface LegacySubscriptionRow {
	id: number;
	provider_state_key: string;
	user_name: string;
	user_id: string | null;
	status: 'active' | 'archived' | 'paused';
	poll_every_minutes: number;
	include_replies: number;
	max_pages: number;
	created_at: number;
}

interface LegacyRuntimeRow {
	source_id: string;
	adapter_key: string;
	identity_namespace: string;
	destination_key: string;
	poll_every_seconds: number;
	status: 'idle' | 'queued' | 'running' | 'backoff' | 'blocked' | 'dead' | 'paused';
	next_poll_at: number;
	queue_token: string | null;
	queued_at: number | null;
	queue_expires_at: number | null;
	lease_token: string | null;
	lease_expires_at: number | null;
	consecutive_failures: number;
	last_attempt_at: number | null;
	last_success_at: number | null;
	last_error_code: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

interface LegacyCheckpointRow {
	source_key: string;
	provider: string;
	initialized_at: number;
	high_water_external_id: string | null;
	next_cursor: string | null;
	pending_high_water_external_id: string | null;
	updated_at: number;
}

interface LegacyItemRow {
	id: number;
	source_key: string;
	external_id: string;
	title: string | null;
	description: string | null;
	link: string | null;
	author: string | null;
	image_url: string | null;
	published_at: number | null;
	metadata_json: string;
	created_at: number;
	updated_at: number;
}

interface LegacyIdentityRow {
	source_key: string;
	alias: string;
	item_id: number;
	created_at: number;
}

interface LegacyDeliveryRow {
	id: number;
	item_id: number;
	destination_key: string;
	status: 'ready' | 'queued' | 'sending' | 'retry' | 'sent' | 'dead' | 'blocked';
	attempt_count: number;
	available_at: number;
	queued_at: number | null;
	lease_token: string | null;
	lease_expires_at: number | null;
	provider_message_id: string | null;
	last_error_code: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
	sent_at: number | null;
}

interface MirrorCursorRow {
	watermark_at: number;
	watermark_id: number;
}

interface IdKeyRow {
	id: number;
	key: string;
}

interface SourceModel {
	key: string;
	type: 'rss_feed' | 'twitter_user';
	identityNamespace: string;
	displayName: string | null;
	status: 'active' | 'paused';
	settingsJson: string;
}

interface ConnectorModel {
	key: string;
	sourceKey: string;
	providerKey: string;
	adapterKey: string;
	status: 'active' | 'paused';
	pollIntervalSeconds: number;
	configJson: string;
	secretRef: string | null;
	runtime: LegacyRuntimeRow;
}

interface Topology {
	connectors: ConnectorModel[];
	connectorIds: Map<string, number>;
	destinationIds: Map<string, number>;
}

export interface SchemaV2MirrorResult {
	contentItems: number;
	messageDeliveries: number;
	connectors: number;
}

export async function mirrorSchemaV2Shadow(env: Env, config: AppConfig): Promise<void> {
	try {
		const result = await new SchemaV2ShadowMirror(env.DB, env.DB_V2, config).run();
		console.info({ event: 'schema_v2_shadow_synced', ...result });
	} catch (error) {
		console.error({
			event: 'schema_v2_shadow_failed',
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class SchemaV2ShadowMirror {
	constructor(
		private readonly legacy: D1Database,
		private readonly v2: D1Database,
		private readonly config: AppConfig,
	) {}

	async run(): Promise<SchemaV2MirrorResult> {
		const topology = await this.syncTopology();
		await this.syncRuntime(topology);
		await this.syncCheckpoints(topology);
		const content = await this.syncContent(topology);
		const deliveries = content.complete && content.count === 0
			? await this.syncDeliveries(topology.destinationIds)
			: { count: 0, complete: false };

		return {
			contentItems: content.count,
			messageDeliveries: deliveries.count,
			connectors: topology.connectors.length,
		};
	}

	private async syncTopology(): Promise<Topology> {
		const [runtimeResult, subscriptionsResult] = await this.legacy.batch([
			this.legacy.prepare(`
				SELECT
					source_id, adapter_key, identity_namespace, destination_key,
					poll_every_seconds, status, next_poll_at, queue_token, queued_at,
					queue_expires_at, lease_token, lease_expires_at,
					consecutive_failures, last_attempt_at, last_success_at,
					last_error_code, last_error, created_at, updated_at
				FROM source_runtime_state
				ORDER BY source_id
			`),
			this.legacy.prepare(`
				SELECT
					id, provider_state_key, user_name, user_id, status,
					poll_every_minutes, include_replies, max_pages, created_at
				FROM twitter_subscriptions
				ORDER BY id
			`),
		]);
		const runtimeRows = runtimeResult.results as unknown as LegacyRuntimeRow[];
		const subscriptions = subscriptionsResult.results as unknown as LegacySubscriptionRow[];
		const sources = new Map<string, SourceModel>();
		const connectors: ConnectorModel[] = [];

		for (const runtime of runtimeRows) {
			const subscription = subscriptionFor(runtime.source_id, subscriptions);
			const source = sourceModel(runtime, subscription);
			const previous = sources.get(source.key);
			if (!previous || source.status === 'active') sources.set(source.key, source);
			connectors.push(connectorModel(runtime, subscription, source.key, this.config));
		}

		const sourceStatements = multiRowStatements(
			this.v2,
			[...sources.values()],
			6,
			(placeholders) => `
			INSERT INTO sources (
				source_key, source_type, identity_namespace, display_name,
				status, settings_json, created_at, updated_at
			) VALUES ${placeholders}
			ON CONFLICT (source_key) DO UPDATE SET
				source_type = excluded.source_type,
				identity_namespace = excluded.identity_namespace,
				display_name = excluded.display_name,
				status = excluded.status,
				settings_json = excluded.settings_json,
				updated_at = excluded.updated_at
			WHERE sources.source_type IS NOT excluded.source_type
				OR sources.identity_namespace IS NOT excluded.identity_namespace
				OR sources.display_name IS NOT excluded.display_name
				OR sources.status IS NOT excluded.status
				OR sources.settings_json IS NOT excluded.settings_json
		`,
			(source) => [
				source.key,
				source.type,
				source.identityNamespace,
				source.displayName,
				source.status,
				source.settingsJson,
			],
			'?, ?, ?, ?, ?, ?, unixepoch(\'now\'), unixepoch(\'now\')',
		);
		await runStatements(this.v2, sourceStatements);

		const sourceIds = await idMap(this.v2, 'sources', 'source_key');
		const destinationKeys = [...new Set(runtimeRows.map((row) => row.destination_key))];
		const destinationRows = destinationKeys.map((legacyKey) => {
			const key = normalizeDestinationKey(legacyKey);
			const destination = this.config.destinations.find(({ destinationKey }) => (
				destinationKey === legacyKey
			));
			return {
				configJson: JSON.stringify({
					messageFormat: destination?.messageFormat ?? 'article',
					parseMode: destination?.parseMode ?? 'HTML',
				}),
				key,
				secretRef: destinationSecretRef(legacyKey),
			};
		});
		const destinationStatements = multiRowStatements(
			this.v2,
			destinationRows,
			3,
			(placeholders) => `
				INSERT INTO destinations (
					destination_key, provider_key, adapter_key, status,
					config_json, secret_ref, created_at, updated_at
				) VALUES ${placeholders}
				ON CONFLICT (destination_key) DO UPDATE SET
					status = excluded.status,
					config_json = excluded.config_json,
					secret_ref = excluded.secret_ref,
					updated_at = excluded.updated_at
				WHERE destinations.status IS NOT excluded.status
					OR destinations.config_json IS NOT excluded.config_json
					OR destinations.secret_ref IS NOT excluded.secret_ref
			`,
			(row) => [row.key, row.configJson, row.secretRef],
			"?, 'telegram', 'telegram.bot', 'active', ?, ?, unixepoch('now'), unixepoch('now')",
		);
		await runStatements(this.v2, destinationStatements);
		const destinationIds = await idMap(this.v2, 'destinations', 'destination_key');

		const connectorStatements = multiRowStatements(
			this.v2,
			connectors,
			10,
			(placeholders) => `
			INSERT INTO source_connectors (
				source_id, connector_key, provider_key, adapter_key, status,
				poll_interval_seconds, config_json, secret_ref, created_at, updated_at
			) VALUES ${placeholders}
			ON CONFLICT (connector_key) DO UPDATE SET
				source_id = excluded.source_id,
				provider_key = excluded.provider_key,
				adapter_key = excluded.adapter_key,
				status = excluded.status,
				poll_interval_seconds = excluded.poll_interval_seconds,
				config_json = excluded.config_json,
				secret_ref = excluded.secret_ref,
				updated_at = excluded.updated_at
			WHERE source_connectors.source_id IS NOT excluded.source_id
				OR source_connectors.provider_key IS NOT excluded.provider_key
				OR source_connectors.adapter_key IS NOT excluded.adapter_key
				OR source_connectors.status IS NOT excluded.status
				OR source_connectors.poll_interval_seconds IS NOT excluded.poll_interval_seconds
				OR source_connectors.config_json IS NOT excluded.config_json
				OR source_connectors.secret_ref IS NOT excluded.secret_ref
		`,
			(connector) => [
				requiredId(sourceIds, connector.sourceKey, 'source'),
				connector.key,
				connector.providerKey,
				connector.adapterKey,
				connector.status,
				connector.pollIntervalSeconds,
				connector.configJson,
				connector.secretRef,
				connector.runtime.created_at,
				connector.runtime.updated_at,
			],
		);
		await runStatements(this.v2, connectorStatements);
		const connectorIds = await idMap(this.v2, 'source_connectors', 'connector_key');

		const routeStatements = multiRowStatements(
			this.v2,
			connectors,
			4,
			(placeholders) => `
			INSERT INTO source_routes (
				source_id, destination_id, status, filter_json, created_at, updated_at
			) VALUES ${placeholders}
			ON CONFLICT (source_id, destination_id) DO UPDATE SET
				status = excluded.status,
				updated_at = excluded.updated_at
			WHERE source_routes.status IS NOT excluded.status
		`,
			(connector) => [
				requiredId(sourceIds, connector.sourceKey, 'source'),
				requiredId(
					destinationIds,
					normalizeDestinationKey(connector.runtime.destination_key),
					'destination',
				),
				connector.runtime.created_at,
				connector.runtime.updated_at,
			],
			"?, ?, 'active', '{}', ?, ?",
		);
		await runStatements(this.v2, routeStatements);

		return { connectors, connectorIds, destinationIds };
	}

	private async syncRuntime(topology: Topology): Promise<void> {
		const rows = topology.connectors.map((connector) => ({
			claim: runtimeClaim(connector.runtime),
			connector,
		}));
		const statements = multiRowStatements(
			this.v2,
			rows,
			13,
			(placeholders) => `
				INSERT INTO source_connector_state (
					connector_id, state, next_run_at, claim_token, claimed_at,
					claim_expires_at, failure_count, last_attempt_at,
					last_success_at, last_error_code, last_error, created_at, updated_at
				) VALUES ${placeholders}
				ON CONFLICT (connector_id) DO UPDATE SET
					state = excluded.state,
					next_run_at = excluded.next_run_at,
					claim_token = excluded.claim_token,
					claimed_at = excluded.claimed_at,
					claim_expires_at = excluded.claim_expires_at,
					failure_count = excluded.failure_count,
					last_attempt_at = excluded.last_attempt_at,
					last_success_at = excluded.last_success_at,
					last_error_code = excluded.last_error_code,
					last_error = excluded.last_error,
					updated_at = excluded.updated_at
				WHERE source_connector_state.state IS NOT excluded.state
					OR source_connector_state.next_run_at IS NOT excluded.next_run_at
					OR source_connector_state.claim_token IS NOT excluded.claim_token
					OR source_connector_state.claimed_at IS NOT excluded.claimed_at
					OR source_connector_state.claim_expires_at IS NOT excluded.claim_expires_at
					OR source_connector_state.failure_count IS NOT excluded.failure_count
					OR source_connector_state.last_attempt_at IS NOT excluded.last_attempt_at
					OR source_connector_state.last_success_at IS NOT excluded.last_success_at
					OR source_connector_state.last_error_code IS NOT excluded.last_error_code
					OR source_connector_state.last_error IS NOT excluded.last_error
			`,
			({ claim, connector }) => {
				const runtime = connector.runtime;
				return [
					requiredId(topology.connectorIds, connector.key, 'connector'),
					claim.state,
					runtime.next_poll_at,
					claim.token,
					claim.claimedAt,
					claim.expiresAt,
					runtime.consecutive_failures,
					runtime.last_attempt_at,
					runtime.last_success_at,
					runtime.last_error_code,
					runtime.last_error,
					runtime.created_at,
					runtime.updated_at,
				];
			},
		);
		await runStatements(this.v2, statements);
	}

	private async syncCheckpoints(topology: Topology): Promise<void> {
		const result = await this.legacy.prepare(`
			SELECT
				source_key, provider, initialized_at, high_water_external_id,
				next_cursor, pending_high_water_external_id, updated_at
			FROM source_ingestion_state
			ORDER BY source_key, provider
		`).all<LegacyCheckpointRow>();
		const rows = result.results.flatMap((checkpoint) => {
			const connectorId = topology.connectorIds.get(normalizeConnectorKey(checkpoint.provider));
			if (!connectorId) return [];
			return [{ checkpoint, connectorId }];
		});
		const statements = multiRowStatements(
			this.v2,
			rows,
			6,
			(placeholders) => `
				INSERT INTO source_connector_checkpoints (
					connector_id, version, initialized_at, high_water_identity,
					cursor, pending_high_water_identity, checkpoint_json, updated_at
				) VALUES ${placeholders}
				ON CONFLICT (connector_id) DO UPDATE SET
					version = source_connector_checkpoints.version + 1,
					initialized_at = excluded.initialized_at,
					high_water_identity = excluded.high_water_identity,
					cursor = excluded.cursor,
					pending_high_water_identity = excluded.pending_high_water_identity,
					updated_at = excluded.updated_at
				WHERE source_connector_checkpoints.initialized_at IS NOT excluded.initialized_at
					OR source_connector_checkpoints.high_water_identity IS NOT excluded.high_water_identity
					OR source_connector_checkpoints.cursor IS NOT excluded.cursor
					OR source_connector_checkpoints.pending_high_water_identity
						IS NOT excluded.pending_high_water_identity
			`,
			({ checkpoint, connectorId }) => [
				connectorId,
				checkpoint.initialized_at,
				checkpoint.high_water_external_id,
				checkpoint.next_cursor,
				checkpoint.pending_high_water_external_id,
				checkpoint.updated_at,
			],
			"?, 0, ?, ?, ?, ?, '{}', ?",
		);
		await runStatements(this.v2, statements);
	}

	private async syncContent(topology: Topology): Promise<{ count: number; complete: boolean }> {
		const cursor = await this.cursor('content_items');
		const result = await this.legacy.prepare(`
			SELECT
				id, source_key, external_id, title, description, link, author,
				image_url, published_at, metadata_json, created_at, updated_at
			FROM items
			WHERE updated_at > ? OR (updated_at = ? AND id > ?)
			ORDER BY updated_at, id
			LIMIT ?
		`).bind(
			cursor.watermark_at,
			cursor.watermark_at,
			cursor.watermark_id,
			PAGE_SIZE,
		).all<LegacyItemRow>();
		const items = result.results;
		if (items.length === 0) {
			await this.advanceCursor('content_items', cursor.watermark_at, cursor.watermark_id, true);
			return { count: 0, complete: true };
		}

		const ids = items.map(({ id }) => id);
		const placeholders = ids.map(() => '?').join(',');
		const aliases = await this.legacy.prepare(`
			SELECT source_key, alias, item_id, created_at
			FROM item_identity_aliases
			WHERE item_id IN (${placeholders})
			ORDER BY item_id, alias
		`).bind(...ids).all<LegacyIdentityRow>();

		await runStatements(this.v2, contentStatements(this.v2, items));
		await runStatements(this.v2, identityStatements(this.v2, items, aliases.results));
		await runStatements(this.v2, observationStatements(
			this.v2,
			items,
			topology,
		));

		const last = items.at(-1)!;
		const complete = items.length < PAGE_SIZE;
		await this.advanceCursor('content_items', last.updated_at, last.id, complete);
		return { count: items.length, complete };
	}

	private async syncDeliveries(
		destinationIds: Map<string, number>,
	): Promise<{ count: number; complete: boolean }> {
		const cursor = await this.cursor('message_deliveries');
		const result = await this.legacy.prepare(`
			SELECT
				id, item_id, destination_key, status, attempt_count, available_at,
				queued_at, lease_token, lease_expires_at, provider_message_id,
				last_error_code, last_error, created_at, updated_at, sent_at
			FROM deliveries
			WHERE updated_at > ? OR (updated_at = ? AND id > ?)
			ORDER BY updated_at, id
			LIMIT ?
		`).bind(
			cursor.watermark_at,
			cursor.watermark_at,
			cursor.watermark_id,
			PAGE_SIZE,
		).all<LegacyDeliveryRow>();
		const rows = result.results;
		if (rows.length === 0) {
			await this.advanceCursor(
				'message_deliveries',
				cursor.watermark_at,
				cursor.watermark_id,
				true,
			);
			return { count: 0, complete: true };
		}

		const deliveryRows = rows.map((row) => ({ row, state: deliveryState(row) }));
		const statements = multiRowStatements(
			this.v2,
			deliveryRows,
			15,
			(placeholders) => `
				INSERT INTO message_deliveries (
					id, item_id, destination_id, trigger_source_id, state,
					attempt_count, next_attempt_at, queued_at, lease_token,
					lease_expires_at, provider_message_id, last_error_code,
					last_error, created_at, updated_at, sent_at
				) VALUES ${placeholders}
				ON CONFLICT (id) DO UPDATE SET
					item_id = excluded.item_id,
					destination_id = excluded.destination_id,
					state = excluded.state,
					attempt_count = excluded.attempt_count,
					next_attempt_at = excluded.next_attempt_at,
					queued_at = excluded.queued_at,
					lease_token = excluded.lease_token,
					lease_expires_at = excluded.lease_expires_at,
					provider_message_id = excluded.provider_message_id,
					last_error_code = excluded.last_error_code,
					last_error = excluded.last_error,
					updated_at = excluded.updated_at,
					sent_at = excluded.sent_at
			`,
			({ row, state }) => [
				row.id,
				row.item_id,
				requiredId(
					destinationIds,
					normalizeDestinationKey(row.destination_key),
					'destination',
				),
				state.state,
				row.attempt_count,
				row.available_at,
				state.queuedAt,
				state.leaseToken,
				state.leaseExpiresAt,
				row.provider_message_id,
				row.last_error_code,
				row.last_error,
				row.created_at,
				row.updated_at,
				state.sentAt,
			],
			'?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?',
		);
		await runStatements(this.v2, statements);
		const last = rows.at(-1)!;
		const complete = rows.length < PAGE_SIZE;
		await this.advanceCursor('message_deliveries', last.updated_at, last.id, complete);
		return { count: rows.length, complete };
	}

	private async cursor(stream: string): Promise<MirrorCursorRow> {
		return await this.v2.prepare(`
			SELECT watermark_at, watermark_id
			FROM schema_mirror_cursors
			WHERE stream = ?
		`).bind(stream).first<MirrorCursorRow>() ?? { watermark_at: 0, watermark_id: 0 };
	}

	private async advanceCursor(
		stream: string,
		watermarkAt: number,
		watermarkId: number,
		complete: boolean,
	): Promise<void> {
		await this.v2.prepare(`
			INSERT INTO schema_mirror_cursors (
				stream, watermark_at, watermark_id, completed_at, updated_at
			) VALUES (?, ?, ?, CASE WHEN ? THEN unixepoch('now') ELSE NULL END, unixepoch('now'))
			ON CONFLICT (stream) DO UPDATE SET
				watermark_at = excluded.watermark_at,
				watermark_id = excluded.watermark_id,
				completed_at = excluded.completed_at,
				updated_at = excluded.updated_at
			WHERE excluded.watermark_at > schema_mirror_cursors.watermark_at
				OR (
					excluded.watermark_at = schema_mirror_cursors.watermark_at
					AND excluded.watermark_id >= schema_mirror_cursors.watermark_id
				)
		`).bind(stream, watermarkAt, watermarkId, complete ? 1 : 0).run();
	}
}

function sourceModel(
	runtime: LegacyRuntimeRow,
	subscription: LegacySubscriptionRow | null,
): SourceModel {
	if (subscription) {
		return {
			key: twitterSourceKey(subscription.user_name),
			type: 'twitter_user',
			identityNamespace: 'twitter:status',
			displayName: subscription.user_name,
			status: subscription.status === 'active' ? 'active' : 'paused',
			settingsJson: JSON.stringify({
				includeReplies: subscription.include_replies === 1,
				userId: subscription.user_id,
				userName: subscription.user_name,
			}),
		};
	}
	return {
		key: rssSourceKey(runtime.source_id),
		type: 'rss_feed',
		identityNamespace: normalizeIdentityNamespace(runtime.identity_namespace),
		displayName: runtime.identity_namespace,
		status: runtime.status === 'paused' ? 'paused' : 'active',
		settingsJson: '{}',
	};
}

function connectorModel(
	runtime: LegacyRuntimeRow,
	subscription: LegacySubscriptionRow | null,
	sourceKey: string,
	config: AppConfig,
): ConnectorModel {
	const providerKey = providerKeyFor(runtime.source_id);
	const rssConfig = config.sources.find((source): source is RssSourceConfig => (
		source.type === 'rss' && source.sourceKey === runtime.identity_namespace
	));
	let connectorConfig: Record<string, unknown> = {};
	let secretRef: string | null = null;
	if (providerKey === 'nitter' && subscription) {
		connectorConfig = {
			baseUrl: config.nitter.baseUrl,
			includeReplies: subscription.include_replies === 1,
			userName: subscription.user_name,
		};
	} else if (providerKey === 'twitterapi_io' && subscription) {
		connectorConfig = {
			endpoint: config.twitterApiIo.endpoint,
			includeReplies: subscription.include_replies === 1,
			maxPages: subscription.max_pages,
			userId: subscription.user_id,
			userName: subscription.user_name,
		};
		secretRef = 'TWITTERAPI_IO_API_KEY';
	} else if (rssConfig) {
		connectorConfig = {
			identityStrategy: rssConfig.identityStrategy,
			parser: rssConfig.parser,
			url: rssConfig.url,
		};
	}
	return {
		key: normalizeConnectorKey(runtime.source_id),
		sourceKey,
		providerKey,
		adapterKey: runtime.adapter_key.toLowerCase(),
		status: runtime.status === 'paused' ? 'paused' : 'active',
		pollIntervalSeconds: runtime.poll_every_seconds,
		configJson: JSON.stringify(connectorConfig),
		secretRef,
		runtime,
	};
}

function subscriptionFor(
	sourceId: string,
	subscriptions: LegacySubscriptionRow[],
): LegacySubscriptionRow | null {
	const nitterId = sourceId.match(/^nitter:subscription:(\d+)$/u)?.[1];
	if (nitterId) {
		return subscriptions.find(({ id }) => id === Number(nitterId)) ?? null;
	}
	return subscriptions.find(({ provider_state_key }) => provider_state_key === sourceId) ?? null;
}

function runtimeClaim(runtime: LegacyRuntimeRow): {
	state: 'idle' | 'queued' | 'running' | 'blocked' | 'dead';
	token: string | null;
	claimedAt: number | null;
	expiresAt: number | null;
} {
	if (runtime.status === 'queued') return {
		state: 'queued',
		token: runtime.queue_token,
		claimedAt: runtime.queued_at,
		expiresAt: runtime.queue_expires_at,
	};
	if (runtime.status === 'running') return {
		state: 'running',
		token: runtime.lease_token,
		claimedAt: runtime.last_attempt_at ?? runtime.updated_at,
		expiresAt: runtime.lease_expires_at,
	};
	if (runtime.status === 'blocked' || runtime.status === 'dead') return {
		state: runtime.status,
		token: null,
		claimedAt: null,
		expiresAt: null,
	};
	return { state: 'idle', token: null, claimedAt: null, expiresAt: null };
}

function contentStatements(db: D1Database, items: LegacyItemRow[]): D1PreparedStatement[] {
	return multiRowStatements(
		db,
		items,
		12,
		(placeholders) => `
		INSERT INTO content_items (
			id, identity_namespace, canonical_id, title, description, url,
			author_name, image_url, published_at, metadata_json, created_at, updated_at
		) VALUES ${placeholders}
		ON CONFLICT (id) DO UPDATE SET
			identity_namespace = excluded.identity_namespace,
			canonical_id = excluded.canonical_id,
			title = excluded.title,
			description = excluded.description,
			url = excluded.url,
			author_name = excluded.author_name,
			image_url = excluded.image_url,
			published_at = excluded.published_at,
			metadata_json = excluded.metadata_json,
			updated_at = excluded.updated_at
		`,
		(item) => [
			item.id,
			normalizeIdentityNamespace(item.source_key),
			item.external_id,
			item.title,
			item.description,
			item.link,
			item.author,
			item.image_url,
			item.published_at,
			item.metadata_json,
			item.created_at,
			item.updated_at,
		],
	);
}

function identityStatements(
	db: D1Database,
	items: LegacyItemRow[],
	aliases: LegacyIdentityRow[],
): D1PreparedStatement[] {
	const rows = new Map<string, LegacyIdentityRow>();
	for (const item of items) {
		const row = {
			source_key: item.source_key,
			alias: item.external_id,
			item_id: item.id,
			created_at: item.created_at,
		};
		rows.set(`${row.source_key}\u0000${row.alias}`, row);
	}
	for (const alias of aliases) rows.set(`${alias.source_key}\u0000${alias.alias}`, alias);
	return multiRowStatements(
		db,
		[...rows.values()],
		5,
		(placeholders) => `
		INSERT INTO item_identities (
			identity_namespace, identity_value, item_id, identity_kind, created_at
		) VALUES ${placeholders}
		ON CONFLICT (identity_namespace, identity_value) DO UPDATE SET
			item_id = excluded.item_id,
			identity_kind = excluded.identity_kind
		WHERE item_id = excluded.item_id
		`,
		(row) => [
			normalizeIdentityNamespace(row.source_key),
			row.alias,
			row.item_id,
			identityKind(row.alias),
			row.created_at,
		],
	);
}

function observationStatements(
	db: D1Database,
	items: LegacyItemRow[],
	topology: Topology,
): D1PreparedStatement[] {
	const connectors = new Map(topology.connectors.map((connector) => [
		`${connector.sourceKey}\u0000${connector.providerKey}`,
		requiredId(topology.connectorIds, connector.key, 'connector'),
	]));
	const rows = items.flatMap((item) => {
		const provider = metadataProvider(item.metadata_json);
		const sourceKey = observedSourceKey(item);
		if (!provider || !sourceKey) return [];
		const connectorId = connectors.get(`${sourceKey}\u0000${provider}`);
		if (!connectorId) return [];
		return [{ connectorId, item }];
	});
	return multiRowStatements(
		db,
		rows,
		6,
		(placeholders) => `
			INSERT INTO item_observations (
				connector_id, item_id, provider_item_id,
				first_observed_at, last_observed_at, metadata_json
			) VALUES ${placeholders}
			ON CONFLICT (connector_id, item_id) DO UPDATE SET
				last_observed_at = MAX(item_observations.last_observed_at, excluded.last_observed_at),
				metadata_json = excluded.metadata_json
		`,
		({ connectorId, item }) => [
			connectorId,
			item.id,
			item.external_id,
			item.created_at,
			item.updated_at,
			item.metadata_json,
		],
	);
}

function deliveryState(row: LegacyDeliveryRow): {
	state: 'pending' | 'queued' | 'sending' | 'sent' | 'dead' | 'blocked';
	queuedAt: number | null;
	leaseToken: string | null;
	leaseExpiresAt: number | null;
	sentAt: number | null;
} {
	if (row.status === 'ready' || row.status === 'retry') {
		return {
			state: 'pending', queuedAt: null, leaseToken: null, leaseExpiresAt: null, sentAt: null,
		};
	}
	if (row.status === 'queued') {
		return {
			state: 'queued',
			queuedAt: row.queued_at ?? row.updated_at,
			leaseToken: null,
			leaseExpiresAt: null,
			sentAt: null,
		};
	}
	if (row.status === 'sending') {
		return {
			state: 'sending',
			queuedAt: null,
			leaseToken: row.lease_token,
			leaseExpiresAt: row.lease_expires_at,
			sentAt: null,
		};
	}
	if (row.status === 'sent') {
		return {
			state: 'sent',
			queuedAt: null,
			leaseToken: null,
			leaseExpiresAt: null,
			sentAt: row.sent_at ?? row.updated_at,
		};
	}
	return {
		state: row.status,
		queuedAt: null,
		leaseToken: null,
		leaseExpiresAt: null,
		sentAt: null,
	};
}

async function idMap(db: D1Database, table: string, keyColumn: string): Promise<Map<string, number>> {
	const result = await db.prepare(`
		SELECT id, ${keyColumn} AS key
		FROM ${table}
	`).all<IdKeyRow>();
	return new Map(result.results.map(({ id, key }) => [key, id]));
}

function multiRowStatements<T>(
	db: D1Database,
	rows: T[],
	bindingsPerRow: number,
	sql: (placeholders: string) => string,
	bindings: (row: T) => unknown[],
	rowTemplate = Array.from({ length: bindingsPerRow }, () => '?').join(', '),
): D1PreparedStatement[] {
	const rowsPerStatement = Math.max(1, Math.floor(90 / bindingsPerRow));
	const statements: D1PreparedStatement[] = [];
	for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
		const chunk = rows.slice(offset, offset + rowsPerStatement);
		const placeholders = chunk.map(() => `(${rowTemplate})`).join(', ');
		const values = chunk.flatMap((row) => bindings(row));
		if (values.length !== chunk.length * bindingsPerRow) {
			throw new Error('Schema v2 mirror binding count does not match row shape');
		}
		statements.push(db.prepare(sql(placeholders)).bind(...values));
	}
	return statements;
}

async function runStatements(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
	for (let offset = 0; offset < statements.length; offset += STATEMENT_BATCH_SIZE) {
		await db.batch(statements.slice(offset, offset + STATEMENT_BATCH_SIZE));
	}
}

function requiredId(map: Map<string, number>, key: string, entity: string): number {
	const id = map.get(key);
	if (!id) throw new Error(`Missing v2 ${entity}: ${key}`);
	return id;
}

function providerKeyFor(sourceId: string): string {
	if (sourceId.startsWith('nitter:')) return 'nitter';
	if (sourceId.startsWith('twitterapi-io:')) return 'twitterapi_io';
	return 'rss';
}

function metadataProvider(metadataJson: string): string | null {
	try {
		const provider = (JSON.parse(metadataJson) as { provider?: unknown }).provider;
		if (provider === 'twitterapi-io') return 'twitterapi_io';
		if (provider === 'nitter' || provider === 'rss') return provider;
	} catch {
		// The legacy table already validates JSON. Treat an unexpected value as
		// non-observable instead of failing the whole shadow sync.
	}
	return null;
}

function observedSourceKey(item: LegacyItemRow): string | null {
	if (item.source_key === 'TWITTER' && item.link) {
		try {
			const handle = new URL(item.link).pathname.match(/^\/([^/]+)\/status\//u)?.[1];
			return handle ? twitterSourceKey(handle) : null;
		} catch {
			return null;
		}
	}
	return rssSourceKey(`rss:${item.source_key.toLowerCase()}`);
}

function normalizeIdentityNamespace(value: string): string {
	if (value.toUpperCase() === 'TWITTER') return 'twitter:status';
	return `rss:${slug(value)}`;
}

function normalizeDestinationKey(value: string): string {
	const [provider, ...rest] = value.split(':');
	return `${provider.toLowerCase()}:${slug(rest.join(':'))}`;
}

function normalizeConnectorKey(value: string): string {
	return value.trim().toLowerCase();
}

function rssSourceKey(sourceId: string): string {
	return `rss:${slug(sourceId.replace(/^rss:/iu, ''))}`;
}

function twitterSourceKey(userName: string): string {
	return `twitter:user:${slug(userName.replace(/^@/u, ''))}`;
}

function slug(value: string): string {
	return value.trim().toLowerCase().replaceAll('_', '-');
}

function destinationSecretRef(destinationKey: string): string | null {
	if (destinationKey === 'telegram:IT_HOME') return 'IT_HOME_CHAT_ID';
	if (destinationKey === 'telegram:TWITTER') return 'TWITTER_CHAT_ID';
	return null;
}

function identityKind(value: string): 'canonical' | 'provider_id' | 'url' {
	if (/^https?:\/\//u.test(value)) return 'url';
	if (/^(twitter:|urn:)/u.test(value)) return 'canonical';
	return 'provider_id';
}
