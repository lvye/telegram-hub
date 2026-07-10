import type {
	DeliveryLease,
	DeliveryState,
	DeliveryStatus,
	DispatchableDelivery,
	ItemInput,
} from '../domain/delivery';

interface DispatchableRow {
	delivery_id: number;
}

interface ExternalIdRow {
	external_id: string;
}

interface MigrationBridgeCursorRow {
	fence: number;
	value: number;
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
		items: ItemInput[],
		now = currentUnixTime(),
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

		const externalIds = [...new Set(items.map((item) => item.externalId))];
		const idPlaceholders = externalIds.map(() => '?').join(', ');
		statements.push(this.db.prepare(`
			INSERT OR IGNORE INTO deliveries (
				item_id,
				destination_key,
				status,
				available_at,
				created_at,
				updated_at
			)
			SELECT id, ?, 'ready', ?, ?, ?
			FROM items
			WHERE source_key = ? AND external_id IN (${idPlaceholders})
		`).bind(destinationKey, now, now, now, sourceKey, ...externalIds));

		await this.db.batch(statements);
	}

	async findExistingExternalIds(sourceKey: string, externalIds: string[]): Promise<Set<string>> {
		assertNonEmpty(sourceKey, 'sourceKey');
		const uniqueIds = [...new Set(externalIds)];
		if (uniqueIds.length === 0) return new Set();

		// Passing the candidate set as one JSON binding keeps this to a single D1
		// query regardless of feed length and avoids SQLite's bind-parameter cap.
		const result = await this.db.prepare(`
			SELECT items.external_id
			FROM json_each(?) AS candidate
			CROSS JOIN items
			WHERE items.source_key = ?
				AND items.external_id = CAST(candidate.value AS TEXT)
		`).bind(JSON.stringify(uniqueIds), sourceKey).all<ExternalIdRow>();

		return new Set(result.results.map((row) => row.external_id));
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
		link: row.link,
		author: row.author,
		imageUrl: row.image_url,
		publishedAt: row.published_at,
	};
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
