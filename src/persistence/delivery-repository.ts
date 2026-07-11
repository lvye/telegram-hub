import type {
	DeliveryLease,
	DeliveryState,
	DeliveryStatus,
	DispatchableDelivery,
} from '../domain/delivery';
import type { CanonicalItem } from '../domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
} from '../ingestion/twitter-api-checkpoint';

interface DispatchableRow {
	delivery_id: number;
}

interface CandidateIdentityRow {
	candidate_external_id: string;
}

interface AmbiguousCandidateRow {
	ambiguous_count: number;
}

interface MigrationBridgeCursorRow {
	fence: number;
	value: number;
}

interface SourceIngestionStateRow {
	high_water_external_id: string | null;
	initialized_at: number;
	last_successful_poll_at: number | null;
	next_cursor: string | null;
	pending_high_water_external_id: string | null;
}

interface SourceProviderBootstrapRow {
	high_water_external_id: string | null;
	published_at: number;
}

interface DeliveryStateRow {
	id: number;
	status: DeliveryStatus;
	attempt_count: number;
	available_at: number;
	lease_expires_at: number | null;
}

interface DeliveryLeaseRow {
	delivery_id: number;
	destination_key: string;
	lease_token: string;
	attempt_count: number;
	source_key: string;
	external_id: string;
	title: string | null;
	description: string | null;
	formatted_description: string | null;
	link: string | null;
	author: string | null;
	image_url: string | null;
	published_at: number | null;
}

// D1 allows at most 100 bound parameters per query. Each item uses 11.
const UPSERT_CHUNK_SIZE = 9;
const UPDATE_ID_CHUNK_SIZE = 98;

export class DeliveryRepository {
	constructor(private readonly db: D1Database) {}

	async reconcileLegacyRows(): Promise<number> {
		const cursor = await this.db.prepare(`
			SELECT value, unixepoch('now') AS fence
			FROM migration_bridge_state
			WHERE key = 'legacy_reconciled_through'
		`).first<MigrationBridgeCursorRow>();
		if (!cursor) throw new Error('Missing legacy reconciliation cursor');

		const [itemsResult, deliveriesResult] = await this.db.batch([
			this.db.prepare(`
				WITH legacy AS (
					SELECT
						COALESCE(NULLIF(TRIM(source), ''), '__legacy_unknown__') AS source_key,
						COALESCE(
							NULLIF(TRIM(id), ''),
							NULLIF(TRIM(link), ''),
							'urn:telegram-hub:legacy-rowid:' || CAST(rowid AS TEXT)
						) AS external_id,
						title,
						description,
						link,
						unixepoch(pubDate) AS published_at,
						COALESCE(unixepoch(createdAt), unixepoch(pubDate), ?) AS created_at,
						COALESCE(
							unixepoch(updatedAt),
							unixepoch(createdAt),
							unixepoch(pubDate),
							?
						) AS updated_at
					FROM pushed_items INDEXED BY idx_pushed_items_updated_epoch
					WHERE unixepoch(updatedAt) >= ?
				)
				INSERT INTO items (
					source_key,
					external_id,
					title,
					description,
					link,
					published_at,
					metadata_json,
					created_at,
					updated_at
				)
				SELECT
					source_key,
					external_id,
					title,
					description,
					link,
					published_at,
					'{}',
					created_at,
					updated_at
				FROM legacy
				WHERE 1
				ON CONFLICT (source_key, external_id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					link = excluded.link,
					published_at = excluded.published_at,
					metadata_json = CASE
						WHEN items.description IS NOT excluded.description THEN json_remove(
							items.metadata_json,
							'$.descriptionFormat',
							'$.telegramHtmlDescription'
						)
						ELSE items.metadata_json
					END,
					updated_at = MAX(items.updated_at, excluded.updated_at)
				WHERE excluded.updated_at > items.updated_at
					AND (
						items.title IS NOT excluded.title
						OR items.description IS NOT excluded.description
						OR items.link IS NOT excluded.link
						OR items.published_at IS NOT excluded.published_at
					)
			`).bind(cursor.fence, cursor.fence, cursor.value),
			this.db.prepare(`
				WITH legacy AS (
					SELECT
						COALESCE(NULLIF(TRIM(source), ''), '__legacy_unknown__') AS source_key,
						COALESCE(
							NULLIF(TRIM(id), ''),
							NULLIF(TRIM(link), ''),
							'urn:telegram-hub:legacy-rowid:' || CAST(rowid AS TEXT)
						) AS external_id,
						CASE
							WHEN status = 'sent' THEN 'sent'
							WHEN status = 'failed' AND NULLIF(TRIM(source), '') IS NOT NULL THEN 'retry'
							ELSE 'blocked'
						END AS delivery_status,
						CASE WHEN status = 'failed' THEN 1 ELSE 0 END AS attempt_count,
						CASE
							WHEN status = 'failed' AND NULLIF(TRIM(source), '') IS NULL THEN 'LEGACY_DESTINATION_UNKNOWN'
							WHEN status = 'failed' THEN 'LEGACY_FAILED'
							WHEN status = 'pending' THEN 'LEGACY_PENDING_AMBIGUOUS'
							WHEN status = 'sent' THEN NULL
							ELSE 'LEGACY_STATUS_UNKNOWN'
						END AS last_error_code,
						lastError AS last_error,
						COALESCE(unixepoch(createdAt), unixepoch(pubDate), ?) AS created_at,
						COALESCE(
							unixepoch(updatedAt),
							unixepoch(createdAt),
							unixepoch(pubDate),
							?
						) AS updated_at,
						CASE
							WHEN status = 'sent' THEN COALESCE(
								unixepoch(sentAt),
								unixepoch(updatedAt),
								unixepoch(createdAt),
								unixepoch(pubDate),
								?
							)
							ELSE NULL
						END AS sent_at
					FROM pushed_items INDEXED BY idx_pushed_items_updated_epoch
					WHERE unixepoch(updatedAt) >= ?
				)
				INSERT INTO deliveries (
					item_id,
					destination_key,
					status,
					attempt_count,
					available_at,
					last_error_code,
					last_error,
					created_at,
					updated_at,
					sent_at
				)
				SELECT
					items.id,
					'telegram:' || legacy.source_key,
					legacy.delivery_status,
					legacy.attempt_count,
					?,
					legacy.last_error_code,
					legacy.last_error,
					legacy.created_at,
					legacy.updated_at,
					legacy.sent_at
				FROM legacy
				JOIN items
					ON items.source_key = legacy.source_key
					AND items.external_id = legacy.external_id
				WHERE 1
				ON CONFLICT (item_id, destination_key) DO UPDATE SET
					status = CASE
						WHEN deliveries.status IN ('sending', 'sent') THEN deliveries.status
						WHEN excluded.status = 'sent' THEN 'sent'
						WHEN deliveries.status = 'dead' THEN deliveries.status
						WHEN excluded.status = 'blocked' THEN 'blocked'
						WHEN deliveries.status = 'blocked' AND excluded.status = 'retry' THEN 'retry'
						ELSE deliveries.status
					END,
					attempt_count = CASE
						WHEN deliveries.status IN ('sending', 'sent', 'dead') THEN deliveries.attempt_count
						ELSE MAX(deliveries.attempt_count, excluded.attempt_count)
					END,
					sent_at = CASE
						WHEN deliveries.status = 'sent' THEN deliveries.sent_at
						WHEN excluded.status = 'sent' AND deliveries.status <> 'sending' THEN excluded.sent_at
						ELSE deliveries.sent_at
					END,
					last_error_code = CASE
						WHEN excluded.status = 'sent' AND deliveries.status <> 'sending' THEN NULL
						WHEN excluded.status IN ('blocked', 'retry')
							AND deliveries.status NOT IN ('sending', 'sent', 'dead')
							THEN excluded.last_error_code
						ELSE deliveries.last_error_code
					END,
					last_error = CASE
						WHEN excluded.status = 'sent' AND deliveries.status <> 'sending' THEN NULL
						WHEN excluded.status IN ('blocked', 'retry')
							AND deliveries.status NOT IN ('sending', 'sent', 'dead')
							THEN excluded.last_error
						ELSE deliveries.last_error
					END,
					updated_at = MAX(deliveries.updated_at, excluded.updated_at)
				WHERE
					(excluded.status = 'sent' AND deliveries.status NOT IN ('sending', 'sent'))
					OR (excluded.status = 'blocked' AND deliveries.status IN ('ready', 'queued', 'retry'))
					OR (excluded.status = 'retry' AND deliveries.status = 'blocked')
			`).bind(cursor.fence, cursor.fence, cursor.fence, cursor.value, cursor.fence),
			this.db.prepare(`
				WITH legacy AS (
					SELECT
						COALESCE(
							NULLIF(TRIM(source), ''),
							'__legacy_unknown__'
						) AS source_key,
						COALESCE(
							NULLIF(TRIM(id), ''),
							NULLIF(TRIM(link), ''),
							'urn:telegram-hub:legacy-rowid:' || CAST(rowid AS TEXT)
						) AS external_id,
						link
					FROM pushed_items INDEXED BY idx_pushed_items_updated_epoch
					WHERE unixepoch(updatedAt) >= ?
				)
				INSERT OR IGNORE INTO item_identity_aliases (
					source_key,
					alias,
					item_id
				)
				SELECT legacy.source_key, legacy.external_id, items.id
				FROM legacy
				CROSS JOIN items INDEXED BY sqlite_autoindex_items_1
				WHERE items.source_key = legacy.source_key
					AND items.external_id = legacy.external_id

				UNION ALL

				SELECT legacy.source_key, legacy.link, items.id
				FROM legacy
				CROSS JOIN items INDEXED BY sqlite_autoindex_items_1
				WHERE legacy.source_key = 'TWITTER'
					AND legacy.link IS NOT NULL
					AND length(trim(legacy.link)) > 0
					AND items.source_key = legacy.source_key
					AND items.external_id = legacy.external_id
			`).bind(cursor.value),
			this.db.prepare(`
				WITH RECURSIVE legacy AS (
					SELECT
						COALESCE(
							NULLIF(TRIM(id), ''),
							NULLIF(TRIM(link), ''),
							'urn:telegram-hub:legacy-rowid:' || CAST(rowid AS TEXT)
						) AS external_id,
						link
					FROM pushed_items INDEXED BY idx_pushed_items_updated_epoch
					WHERE TRIM(source) = 'TWITTER'
						AND unixepoch(updatedAt) >= ?
						AND link IS NOT NULL
						AND instr(link, '/status/') > 0
				),
				twitter_status_ids (
					item_id,
					source_key,
					tweet_id,
					rest
				) AS (
					SELECT
						items.id,
						items.source_key,
						'',
						substr(
							legacy.link,
							instr(legacy.link, '/status/') + length('/status/')
						)
					FROM legacy
					CROSS JOIN items INDEXED BY sqlite_autoindex_items_1
					WHERE items.source_key = 'TWITTER'
						AND items.external_id = legacy.external_id

					UNION ALL

					SELECT
						item_id,
						source_key,
						tweet_id || substr(rest, 1, 1),
						substr(rest, 2)
					FROM twitter_status_ids
					WHERE length(rest) > 0
						AND substr(rest, 1, 1) GLOB '[0-9]'
				)
				INSERT OR IGNORE INTO item_identity_aliases (
					source_key,
					alias,
					item_id
				)
				SELECT source_key, 'twitter:' || tweet_id, item_id
				FROM twitter_status_ids
				WHERE length(tweet_id) > 0
					AND (
						length(rest) = 0
						OR substr(rest, 1, 1) NOT GLOB '[0-9]'
					)
			`).bind(cursor.value),
			this.db.prepare(`
				INSERT INTO migration_bridge_state (key, value)
				SELECT
					'legacy_reconciled_through',
					MIN(
						?,
						COALESCE((
							SELECT MIN(unixepoch(legacy.updatedAt))
							FROM pushed_items AS legacy INDEXED BY idx_pushed_items_updated_epoch
							JOIN items
								ON items.source_key = COALESCE(
									NULLIF(TRIM(legacy.source), ''),
									'__legacy_unknown__'
								)
								AND items.external_id = COALESCE(
									NULLIF(TRIM(legacy.id), ''),
									NULLIF(TRIM(legacy.link), ''),
									'urn:telegram-hub:legacy-rowid:' || CAST(legacy.rowid AS TEXT)
								)
							JOIN deliveries
								ON deliveries.item_id = items.id
								AND deliveries.destination_key = 'telegram:' || items.source_key
							WHERE unixepoch(legacy.updatedAt) >= ?
								AND deliveries.status = 'sending'
						), ?)
					)
				ON CONFLICT (key) DO UPDATE SET
					value = excluded.value
				WHERE excluded.value > migration_bridge_state.value
			`).bind(cursor.fence, cursor.value, cursor.fence),
		]);

		return (itemsResult.meta.changes ?? 0) + (deliveriesResult.meta.changes ?? 0);
	}

	async upsertItems(
		sourceKey: string,
		destinationKey: string,
		items: CanonicalItem[],
		now = currentUnixTime(),
		_sourceId?: string,
	): Promise<void> {
		assertNonEmpty(sourceKey, 'sourceKey');
		assertNonEmpty(destinationKey, 'destinationKey');
		if (items.length === 0) return;
		for (const item of items) assertNonEmpty(item.externalId, 'item.externalId');

		const statements: D1PreparedStatement[] = [];
		for (let offset = 0; offset < items.length; offset += UPSERT_CHUNK_SIZE) {
			const chunk = items.slice(offset, offset + UPSERT_CHUNK_SIZE);
			const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
			const bindings = chunk.flatMap((item) => [
				sourceKey,
				item.externalId,
				item.title,
				item.description,
				item.link,
				item.author,
				item.imageUrl,
				item.publishedAt,
				JSON.stringify(item.metadata ?? {}),
				now,
				now,
			]);

			statements.push(this.db.prepare(`
				INSERT INTO items (
					source_key,
					external_id,
					title,
					description,
					link,
					author,
					image_url,
					published_at,
					metadata_json,
					created_at,
					updated_at
				)
				VALUES ${placeholders}
				ON CONFLICT (source_key, external_id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					link = excluded.link,
					author = excluded.author,
					image_url = excluded.image_url,
					published_at = excluded.published_at,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at
				WHERE
					items.title IS NOT excluded.title
					OR items.description IS NOT excluded.description
					OR items.link IS NOT excluded.link
					OR items.author IS NOT excluded.author
					OR items.image_url IS NOT excluded.image_url
					OR items.published_at IS NOT excluded.published_at
					OR items.metadata_json IS NOT excluded.metadata_json
			`).bind(...bindings));
		}

		const aliasPayload = items.map((item) => ({
			externalId: item.externalId,
			aliases: itemAliases(item),
		}));
		statements.push(this.db.prepare(`
			INSERT OR IGNORE INTO item_identity_aliases (
				source_key,
				alias,
				item_id,
				created_at
			)
			SELECT
				?,
				CAST(candidate_alias.value AS TEXT),
				items.id,
				?
			FROM json_each(?) AS candidate
			JOIN json_each(candidate.value, '$.aliases') AS candidate_alias
			CROSS JOIN items INDEXED BY sqlite_autoindex_items_1
			WHERE items.source_key = ?
				AND items.external_id = CAST(
					json_extract(candidate.value, '$.externalId') AS TEXT
				)
				AND candidate_alias.type = 'text'
				AND length(trim(CAST(candidate_alias.value AS TEXT))) > 0
		`).bind(sourceKey, now, JSON.stringify(aliasPayload), sourceKey));

		statements.push(this.db.prepare(`
			INSERT OR IGNORE INTO deliveries (
				item_id,
				destination_key,
				status,
				available_at,
				created_at,
				updated_at
			)
			SELECT items.id, ?, 'ready', ?, ?, ?
			FROM json_each(?) AS candidate
			CROSS JOIN items INDEXED BY sqlite_autoindex_items_1
			WHERE items.source_key = ?
				AND items.external_id = CAST(
					json_extract(candidate.value, '$.externalId') AS TEXT
				)
				AND NOT EXISTS (
				SELECT 1
				FROM json_each(candidate.value, '$.aliases') AS candidate_alias
				WHERE candidate_alias.type = 'text'
					AND EXISTS (
						SELECT 1
						FROM item_identity_aliases AS existing
							INDEXED BY sqlite_autoindex_item_identity_aliases_1
						WHERE existing.source_key = ?
							AND existing.alias = CAST(candidate_alias.value AS TEXT)
							AND existing.item_id <> items.id
					)
			)
		`).bind(
			destinationKey,
			now,
			now,
			now,
			JSON.stringify(aliasPayload),
			sourceKey,
			sourceKey,
		));

		await this.db.batch(statements);
	}

	async findExistingItemIdentities(
		sourceKey: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
	): Promise<Set<string>> {
		assertNonEmpty(sourceKey, 'sourceKey');
		const uniqueCandidates = [...new Map(candidates.map((candidate) => [
			candidate.externalId,
			{
				externalId: candidate.externalId,
				aliases: itemAliases(candidate),
			},
		])).values()];
		if (uniqueCandidates.length === 0) return new Set();

		// Return the candidate identity rather than the stored identity. Alias
		// lookups are exact and indexed, so a provider switch can reuse an existing
		// item without an OR join that scans the source history.
		const result = await this.db.prepare(`
			SELECT DISTINCT
				CAST(json_extract(candidate.value, '$.externalId') AS TEXT)
					AS candidate_external_id
			FROM json_each(?) AS candidate
			JOIN json_each(candidate.value, '$.aliases') AS candidate_alias
			WHERE candidate_alias.type = 'text'
				AND EXISTS (
					SELECT 1
					FROM item_identity_aliases AS existing
					WHERE existing.source_key = ?
						AND existing.alias = CAST(candidate_alias.value AS TEXT)
				)
		`).bind(JSON.stringify(uniqueCandidates), sourceKey).all<CandidateIdentityRow>();

		return new Set(result.results.map((row) => row.candidate_external_id));
	}

	async ensureDeliveriesForCandidates(
		sourceKey: string,
		destinationKey: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
		now = currentUnixTime(),
		_sourceId?: string,
	): Promise<number> {
		assertNonEmpty(sourceKey, 'sourceKey');
		assertNonEmpty(destinationKey, 'destinationKey');
		if (candidates.length === 0) return 0;

		const payload = candidates.map((candidate) => ({
			aliases: itemAliases(candidate),
		}));
		const encodedPayload = JSON.stringify(payload);
		const [ambiguityResult, insertResult] = await this.db.batch([
			this.db.prepare(`
				SELECT COUNT(*) AS ambiguous_count
				FROM (
					SELECT candidate.key
					FROM json_each(?) AS candidate
					JOIN json_each(candidate.value, '$.aliases') AS candidate_alias
					JOIN item_identity_aliases AS existing
						ON existing.source_key = ?
						AND existing.alias = CAST(candidate_alias.value AS TEXT)
					WHERE candidate_alias.type = 'text'
					GROUP BY candidate.key
					HAVING COUNT(DISTINCT existing.item_id) > 1
				)
			`).bind(encodedPayload, sourceKey),
			this.db.prepare(`
				WITH resolved_candidates AS (
					SELECT MIN(existing.item_id) AS item_id
					FROM json_each(?) AS candidate
					JOIN json_each(candidate.value, '$.aliases') AS candidate_alias
					JOIN item_identity_aliases AS existing
						ON existing.source_key = ?
						AND existing.alias = CAST(candidate_alias.value AS TEXT)
					WHERE candidate_alias.type = 'text'
					GROUP BY candidate.key
					HAVING COUNT(DISTINCT existing.item_id) = 1
				)
				INSERT OR IGNORE INTO deliveries (
					item_id,
					destination_key,
					status,
					available_at,
					created_at,
					updated_at
				)
				SELECT DISTINCT item_id, ?, 'ready', ?, ?, ?
				FROM resolved_candidates
			`).bind(
				encodedPayload,
				sourceKey,
				destinationKey,
				now,
				now,
				now,
			),
		]);
		const ambiguity = ambiguityResult.results[0] as unknown as AmbiguousCandidateRow | undefined;
		if ((ambiguity?.ambiguous_count ?? 0) > 0) {
			throw new Error(
				`Ambiguous item identity aliases for ${sourceKey}: `
				+ `${ambiguity!.ambiguous_count} candidate(s) matched multiple items`,
			);
		}

		return insertResult.meta.changes ?? 0;
	}

	async getOrCreateSourceProviderState(
		sourceKey: string,
		provider: string,
		fallbackInitializedAt: number,
		overlapSeconds = 60,
		bootstrapUserName: string | null = null,
	): Promise<TwitterApiIoCheckpoint> {
		assertNonEmpty(sourceKey, 'sourceKey');
		assertNonEmpty(provider, 'provider');
		const existing = await this.findSourceProviderState(sourceKey, provider);
		if (existing) return existing;

		const bootstrap = await this.db.prepare(`
			WITH latest_tweet AS (
				SELECT aliases.alias, items.published_at
				FROM item_identity_aliases AS aliases
					INDEXED BY sqlite_autoindex_item_identity_aliases_1
				JOIN items ON items.id = aliases.item_id
				WHERE aliases.source_key = ?
					AND aliases.alias GLOB 'twitter:[0-9]*'
					AND (
						? IS NULL
						OR instr(
							lower(COALESCE(items.link, '')),
							'/' || lower(?) || '/status/'
						) > 0
					)
				ORDER BY
					(items.published_at IS NULL) ASC,
					items.published_at DESC,
					items.id DESC
				LIMIT 1
			),
			latest_item AS (
				SELECT MAX(published_at) AS published_at
				FROM items
				WHERE source_key = ?
			)
			SELECT
				latest_tweet.alias AS high_water_external_id,
				CASE
					WHEN latest_tweet.alias IS NOT NULL
						THEN COALESCE(latest_tweet.published_at, 0)
					WHEN ? IS NULL
						THEN COALESCE(latest_item.published_at, ?)
					ELSE ?
				END AS published_at
			FROM latest_item
			LEFT JOIN latest_tweet ON 1 = 1
		`).bind(
			sourceKey,
			bootstrapUserName,
			bootstrapUserName,
			sourceKey,
			bootstrapUserName,
			fallbackInitializedAt,
			fallbackInitializedAt,
		).first<SourceProviderBootstrapRow>();
		if (!bootstrap) throw new Error(`Could not bootstrap source ingestion state for ${sourceKey}`);

		await this.db.prepare(`
			INSERT OR IGNORE INTO source_ingestion_state (
				source_key,
				provider,
				initialized_at,
				high_water_external_id,
				updated_at
			)
			VALUES (?, ?, ?, ?, unixepoch('now'))
		`).bind(
			sourceKey,
			provider,
			Math.max(0, bootstrap.published_at - overlapSeconds),
			bootstrap.high_water_external_id,
		).run();

		const created = await this.findSourceProviderState(sourceKey, provider);
		if (!created) throw new Error(`Missing source ingestion state for ${sourceKey}/${provider}`);
		return created;
	}

	async getSourceProviderState(
		sourceKey: string,
		provider: string,
	): Promise<TwitterApiIoCheckpoint> {
		assertNonEmpty(sourceKey, 'sourceKey');
		assertNonEmpty(provider, 'provider');
		const state = await this.findSourceProviderState(sourceKey, provider);
		if (!state) throw new Error(`Missing source ingestion state for ${sourceKey}/${provider}`);
		return state;
	}

	private async findSourceProviderState(
		sourceKey: string,
		provider: string,
	): Promise<TwitterApiIoCheckpoint | null> {
		const state = await this.db.prepare(`
			SELECT
				initialized_at,
				last_successful_poll_at,
				high_water_external_id,
				next_cursor,
				pending_high_water_external_id
			FROM source_ingestion_state
			WHERE source_key = ? AND provider = ?
		`).bind(sourceKey, provider).first<SourceIngestionStateRow>();
		if (!state) return null;

		return {
			highWaterExternalId: state.high_water_external_id,
			initializedAt: state.initialized_at,
			lastSuccessfulPollAt: state.last_successful_poll_at,
			nextCursor: state.next_cursor,
			pendingHighWaterExternalId: state.pending_high_water_external_id,
		};
	}

	async updateSourceIngestionProgress(
		sourceKey: string,
		provider: string,
		previous: TwitterApiIoCheckpoint,
		progress: TwitterApiIoCheckpointProgress,
		now = currentUnixTime(),
	): Promise<void> {
		assertNonEmpty(sourceKey, 'sourceKey');
		assertNonEmpty(provider, 'provider');
		if ((progress.nextCursor === null) !== (progress.pendingHighWaterExternalId === null)) {
			throw new Error('Source continuation cursor and pending high-water must be set together');
		}

		const result = await this.db.prepare(`
			UPDATE source_ingestion_state
			SET
				high_water_external_id = ?,
				next_cursor = ?,
				pending_high_water_external_id = ?,
				last_successful_poll_at = ?,
				updated_at = ?
			WHERE source_key = ?
				AND provider = ?
				AND high_water_external_id IS ?
				AND next_cursor IS ?
				AND pending_high_water_external_id IS ?
		`).bind(
			progress.highWaterExternalId,
			progress.nextCursor,
			progress.pendingHighWaterExternalId,
			now,
			now,
			sourceKey,
			provider,
			previous.highWaterExternalId,
			previous.nextCursor,
			previous.pendingHighWaterExternalId,
		).run();
		if ((result.meta.changes ?? 0) !== 1) {
			throw new Error(`Source ingestion state changed concurrently for ${sourceKey}/${provider}`);
		}
	}

	async listDispatchable(now = currentUnixTime(), limit = 100): Promise<DispatchableDelivery[]> {
		const result = await this.db.prepare(`
			SELECT id AS delivery_id
			FROM deliveries
			WHERE status IN ('ready', 'retry')
				AND available_at <= ?
			ORDER BY available_at ASC, id ASC
			LIMIT ?
		`).bind(now, limit).all<DispatchableRow>();

		return result.results.map((row) => ({ deliveryId: row.delivery_id }));
	}

	async markQueued(deliveryIds: number[], now = currentUnixTime()): Promise<void> {
		if (deliveryIds.length === 0) return;

		for (let offset = 0; offset < deliveryIds.length; offset += UPDATE_ID_CHUNK_SIZE) {
			const chunk = deliveryIds.slice(offset, offset + UPDATE_ID_CHUNK_SIZE);
			const placeholders = chunk.map(() => '?').join(', ');
			await this.db.prepare(`
				UPDATE deliveries
				SET
					status = 'queued',
					queued_at = ?,
					updated_at = ?
				WHERE id IN (${placeholders}) AND status IN ('ready', 'retry')
			`).bind(now, now, ...chunk).run();
		}
	}

	async acquireLease(
		deliveryId: number,
		leaseToken: string,
		now = currentUnixTime(),
		leaseSeconds = 120,
		maxAttempts = 5,
	): Promise<DeliveryLease | null> {
		const leaseExpiresAt = now + leaseSeconds;
		const [claimResult, readResult] = await this.db.batch<DeliveryLeaseRow>([
			this.db.prepare(`
				UPDATE deliveries
				SET
					status = 'sending',
					attempt_count = attempt_count + 1,
					lease_token = ?,
					lease_expires_at = ?,
					updated_at = ?
				WHERE id = ?
					AND attempt_count < ?
					AND (
						(status IN ('ready', 'queued', 'retry') AND available_at <= ?)
						OR (status = 'sending' AND lease_expires_at <= ?)
					)
			`).bind(leaseToken, leaseExpiresAt, now, deliveryId, maxAttempts, now, now),
			this.db.prepare(`
				SELECT
					d.id AS delivery_id,
					d.destination_key,
					d.lease_token,
					d.attempt_count,
					i.source_key,
					i.external_id,
					i.title,
					i.description,
					CASE
						WHEN json_extract(i.metadata_json, '$.descriptionFormat') = 'telegram-html-v1'
							AND json_type(i.metadata_json, '$.telegramHtmlDescription') = 'text'
						THEN json_extract(i.metadata_json, '$.telegramHtmlDescription')
						ELSE NULL
					END AS formatted_description,
					i.link,
					i.author,
					i.image_url,
					i.published_at
				FROM deliveries AS d
				JOIN items AS i ON i.id = d.item_id
				WHERE d.id = ? AND d.lease_token = ?
			`).bind(deliveryId, leaseToken),
		]);

		if ((claimResult.meta.changes ?? 0) !== 1) return null;

		const row = readResult.results[0];
		return row ? mapLease(row) : null;
	}

	async getState(deliveryId: number): Promise<DeliveryState | null> {
		const row = await this.db.prepare(`
			SELECT id, status, attempt_count, available_at, lease_expires_at
			FROM deliveries
			WHERE id = ?
		`).bind(deliveryId).first<DeliveryStateRow>();

		return row ? {
			id: row.id,
			status: row.status,
			attemptCount: row.attempt_count,
			availableAt: row.available_at,
			leaseExpiresAt: row.lease_expires_at,
		} : null;
	}

	async markSent(
		deliveryId: number,
		leaseToken: string,
		providerMessageId: string | null,
		now = currentUnixTime(),
	): Promise<boolean> {
		const [result] = await this.db.batch([
			this.db.prepare(`
				UPDATE deliveries
				SET
					status = 'sent',
					provider_message_id = ?,
					sent_at = ?,
					updated_at = ?,
					lease_token = NULL,
					lease_expires_at = NULL,
					last_error_code = NULL,
					last_error = NULL
				WHERE id = ? AND status = 'sending' AND lease_token = ?
			`).bind(providerMessageId, now, now, deliveryId, leaseToken),
			// Temporary rollback bridge: keep the legacy sent ledger current while
			// pushed_items remains available to the previous Worker version.
			this.db.prepare(`
				INSERT INTO pushed_items (
					id,
					title,
					description,
					link,
					pubDate,
					source,
					status,
					createdAt,
					updatedAt,
					sentAt,
					lastError
				)
				SELECT
					i.external_id,
					i.title,
					i.description,
					i.link,
					CASE
						WHEN i.published_at IS NULL THEN NULL
						ELSE strftime('%Y-%m-%dT%H:%M:%fZ', i.published_at, 'unixepoch')
					END,
					i.source_key,
					'sent',
					strftime('%Y-%m-%dT%H:%M:%fZ', i.created_at, 'unixepoch'),
					CURRENT_TIMESTAMP,
					CURRENT_TIMESTAMP,
					NULL
				FROM deliveries AS d
				JOIN items AS i ON i.id = d.item_id
				WHERE d.id = ? AND d.status = 'sent'
				ON CONFLICT (id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					link = excluded.link,
					pubDate = excluded.pubDate,
					source = excluded.source,
					status = 'sent',
					updatedAt = CURRENT_TIMESTAMP,
					sentAt = CURRENT_TIMESTAMP,
					lastError = NULL
			`).bind(deliveryId),
		]);

		return (result.meta.changes ?? 0) === 1;
	}

	async releaseForQueueRetry(
		deliveryId: number,
		leaseToken: string,
		availableAt: number,
		errorCode: string,
		errorMessage: string,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE deliveries
			SET
				status = 'queued',
				available_at = ?,
				queued_at = ?,
				updated_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ?,
				last_error = ?
			WHERE id = ? AND status = 'sending' AND lease_token = ?
		`).bind(availableAt, now, now, errorCode, truncateError(errorMessage), deliveryId, leaseToken).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async markDead(
		deliveryId: number,
		leaseToken: string,
		errorCode: string,
		errorMessage: string,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE deliveries
			SET
				status = 'dead',
				updated_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ?,
				last_error = ?
			WHERE id = ? AND status = 'sending' AND lease_token = ?
		`).bind(now, errorCode, truncateError(errorMessage), deliveryId, leaseToken).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async markDeadIfExhausted(
		deliveryId: number,
		maxAttempts: number,
		errorCode: string,
		errorMessage: string,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE deliveries
			SET
				status = 'dead',
				updated_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ?,
				last_error = ?
			WHERE id = ?
				AND attempt_count >= ?
				AND (
					status IN ('ready', 'queued', 'retry')
					OR (status = 'sending' AND lease_expires_at <= ?)
				)
		`).bind(now, errorCode, truncateError(errorMessage), deliveryId, maxAttempts, now).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async reconcileDeadLetter(
		deliveryId: number,
		maxAttempts: number,
		now = currentUnixTime(),
	): Promise<'dead' | 'retry' | null> {
		const result = await this.db.prepare(`
			UPDATE deliveries
			SET
				status = CASE WHEN attempt_count >= ? THEN 'dead' ELSE 'retry' END,
				available_at = MAX(available_at, ?),
				updated_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = CASE
					WHEN attempt_count >= ? THEN 'QUEUE_DEAD_LETTERED'
					ELSE 'QUEUE_DEAD_LETTERED_RETRY'
				END,
				last_error = COALESCE(last_error, 'Cloudflare Queue retries were exhausted')
			WHERE id = ?
				AND (
					status IN ('ready', 'queued', 'retry')
					OR (status = 'sending' AND lease_expires_at <= ?)
				)
		`).bind(maxAttempts, now, now, maxAttempts, deliveryId, now).run();

		if ((result.meta.changes ?? 0) !== 1) return null;
		const state = await this.getState(deliveryId);
		return state?.status === 'dead' ? 'dead' : 'retry';
	}

	async recoverStaleDeliveries(
		now = currentUnixTime(),
		queuedStaleSeconds = 172_800,
	): Promise<number> {
		const queuedCutoff = now - queuedStaleSeconds;
		const results = await this.db.batch([
			this.db.prepare(`
				UPDATE deliveries
				SET
					status = 'retry',
					available_at = ?,
					updated_at = ?,
					lease_token = NULL,
					lease_expires_at = NULL,
					last_error_code = 'LEASE_EXPIRED',
					last_error = 'Previous delivery lease expired'
				WHERE status = 'sending' AND lease_expires_at <= ?
			`).bind(now, now, now),
			this.db.prepare(`
				UPDATE deliveries
				SET
					status = 'retry',
					available_at = ?,
					updated_at = ?,
					last_error_code = 'STALE_QUEUED',
					last_error = 'Queued delivery exceeded the recovery threshold'
				WHERE status = 'queued'
					AND updated_at <= ?
					AND available_at <= ?
			`).bind(now, now, queuedCutoff, now),
		]);

		return results.reduce((total, result) => total + (result.meta.changes ?? 0), 0);
	}

	async compactDeliveredItems(retentionDays: number, now = currentUnixTime()): Promise<number> {
		const cutoff = now - retentionDays * 86_400;
		const result = await this.db.prepare(`
			UPDATE items
			SET description = NULL, image_url = NULL, metadata_json = '{}'
			WHERE id IN (
				SELECT item_id
				FROM deliveries
				GROUP BY item_id
				HAVING MAX(updated_at) < ?
					AND SUM(CASE WHEN status NOT IN ('sent', 'dead') THEN 1 ELSE 0 END) = 0
			)
			AND (description IS NOT NULL OR image_url IS NOT NULL OR metadata_json <> '{}')
		`).bind(cutoff).run();

		return result.meta.changes ?? 0;
	}

	async cleanupLegacyRows(retentionDays: number, now = currentUnixTime()): Promise<number> {
		const cutoff = now - retentionDays * 86_400;
		const result = await this.db.prepare(`
			DELETE FROM pushed_items
			WHERE COALESCE(
				unixepoch(sentAt),
				unixepoch(updatedAt),
				unixepoch(createdAt),
				unixepoch(pubDate),
				0
			) < ?
		`).bind(cutoff).run();

		return result.meta.changes ?? 0;
	}
}

function mapLease(row: DeliveryLeaseRow): DeliveryLease {
	return {
		deliveryId: row.delivery_id,
		destinationKey: row.destination_key,
		leaseToken: row.lease_token,
		attemptCount: row.attempt_count,
		sourceKey: row.source_key,
		externalId: row.external_id,
		title: row.title,
		description: row.description,
		formattedDescription: row.formatted_description,
		link: row.link,
		author: row.author,
		imageUrl: row.image_url,
		publishedAt: row.published_at,
	};
}

function itemAliases(
	item: Pick<CanonicalItem, 'externalId' | 'identityAliases'>,
): string[] {
	return [...new Set([
		item.externalId,
		...(item.identityAliases ?? []),
	].map((alias) => alias.trim()).filter(Boolean))];
}

function assertNonEmpty(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function truncateError(message: string): string {
	return message.slice(0, 1_000);
}

function currentUnixTime(): number {
	return Math.floor(Date.now() / 1_000);
}
