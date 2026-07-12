import { normalizeDestinationKey } from '../config';
import type {
	DeliveryLease,
	DeliveryState,
} from '../domain/delivery';
import type { CanonicalItem } from '../domain/ingestion';
import {
	EMPTY_SOURCE_HTTP_CACHE_ENTRY,
	type SourceHttpCacheEntry,
} from '../ingestion/source-http-cache';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointProgress,
} from '../ingestion/twitter-api-checkpoint';
import type {
	IngestionRepository,
	ResolvedItemCandidate,
} from './ingestion-repository';

interface IdentityMatchRow {
	identity_value: string;
	item_id: number;
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

interface DeliveryStateRow {
	id: number;
	state: 'pending' | 'queued' | 'sending' | 'sent' | 'dead' | 'blocked';
	attempt_count: number;
	next_attempt_at: number;
	lease_expires_at: number | null;
	last_error_code: string | null;
}

interface CheckpointRow {
	initialized_at: number;
	high_water_identity: string | null;
	cursor: string | null;
	pending_high_water_identity: string | null;
	last_success_at: number | null;
}

const UPSERT_CHUNK_SIZE = 9;
const UPDATE_ID_CHUNK_SIZE = 98;
const IDENTITY_LOOKUP_CHUNK_SIZE = 99;
const OBSERVATION_REFRESH_SECONDS = 24 * 60 * 60;
const MAX_ERROR_LENGTH = 1_000;

export class DeliveryRepository implements IngestionRepository {
	constructor(private readonly db: D1Database) {}

	async upsertItems(
		identityNamespace: string,
		destinationKey: string,
		items: CanonicalItem[],
		now = currentUnixTime(),
		sourceId?: string,
	): Promise<void> {
		if (items.length === 0) return;
		const statements: D1PreparedStatement[] = [];
		for (let offset = 0; offset < items.length; offset += UPSERT_CHUNK_SIZE) {
			const chunk = items.slice(offset, offset + UPSERT_CHUNK_SIZE);
			const placeholders = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
			statements.push(this.db.prepare(`
				INSERT INTO content_items (
					identity_namespace, canonical_id, title, description, url,
					author_name, image_url, published_at, metadata_json,
					created_at, updated_at
				) VALUES ${placeholders}
				ON CONFLICT (identity_namespace, canonical_id) DO UPDATE SET
					title = excluded.title,
					description = excluded.description,
					url = excluded.url,
					author_name = excluded.author_name,
					image_url = excluded.image_url,
					published_at = excluded.published_at,
					metadata_json = excluded.metadata_json,
					updated_at = excluded.updated_at
				WHERE content_items.title IS NOT excluded.title
					OR content_items.description IS NOT excluded.description
					OR content_items.url IS NOT excluded.url
					OR content_items.author_name IS NOT excluded.author_name
					OR content_items.image_url IS NOT excluded.image_url
					OR content_items.published_at IS NOT excluded.published_at
					OR content_items.metadata_json IS NOT excluded.metadata_json
			`).bind(...chunk.flatMap((item) => [
				identityNamespace,
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
			])));
		}

		const candidates = candidatePayload(items);
		statements.push(this.db.prepare(`
			WITH candidates AS MATERIALIZED (
				SELECT
					candidate.value,
					CAST(json_extract(candidate.value, '$.externalId') AS TEXT) AS external_id,
					(
						SELECT items.id
						FROM content_items AS items
						WHERE items.identity_namespace = ?
							AND items.canonical_id = CAST(
								json_extract(candidate.value, '$.externalId') AS TEXT
							)
					) AS item_id
				FROM json_each(?) AS candidate
			)
			INSERT INTO item_identities (
				identity_namespace, identity_value, item_id, identity_kind, created_at
			)
			SELECT
				?,
				CAST(alias.value AS TEXT),
				candidates.item_id,
				CASE
					WHEN CAST(alias.value AS TEXT) LIKE 'http%' THEN 'url'
					WHEN CAST(alias.value AS TEXT) = candidates.external_id
						THEN 'canonical'
					ELSE 'provider_id'
				END,
				?
			FROM candidates
			JOIN json_each(candidates.value, '$.aliases') AS alias
			WHERE alias.type = 'text' AND length(trim(CAST(alias.value AS TEXT))) > 0
			ON CONFLICT (identity_namespace, identity_value) DO NOTHING
		`).bind(identityNamespace, candidates, identityNamespace, now));

		if (sourceId) {
			statements.push(this.db.prepare(`
				WITH candidates AS MATERIALIZED (
					SELECT
						CAST(json_extract(candidate.value, '$.externalId') AS TEXT) AS external_id,
						CAST(json_extract(candidate.value, '$.metadataJson') AS TEXT) AS metadata_json,
						(
							SELECT items.id
							FROM content_items AS items
							WHERE items.identity_namespace = ?
								AND items.canonical_id = CAST(
									json_extract(candidate.value, '$.externalId') AS TEXT
								)
						) AS item_id
					FROM json_each(?) AS candidate
				)
				INSERT INTO item_observations (
					connector_id, item_id, provider_item_id,
					first_observed_at, last_observed_at, metadata_json
				)
				SELECT
					connectors.id,
					candidates.item_id,
					candidates.external_id,
					?, ?, candidates.metadata_json
				FROM candidates
				JOIN source_connectors AS connectors ON connectors.connector_key = ?
				ON CONFLICT (connector_id, item_id) DO UPDATE SET
					last_observed_at = excluded.last_observed_at,
					metadata_json = excluded.metadata_json
			`).bind(identityNamespace, candidates, now, now, sourceId));
		}

		statements.push(this.insertDeliveriesStatement(
			identityNamespace,
			destinationKey,
			candidates,
			now,
			sourceId,
		));
		await this.db.batch(statements);
	}

	async resolveExistingItems(
		identityNamespace: string,
		candidates: Array<Pick<CanonicalItem, 'externalId' | 'identityAliases'>>,
	): Promise<ResolvedItemCandidate[]> {
		if (candidates.length === 0) return [];

		const candidateIdsByAlias = new Map<string, Set<string>>();
		const candidateOrder: string[] = [];
		const seenCandidateIds = new Set<string>();
		for (const candidate of candidates) {
			if (!seenCandidateIds.has(candidate.externalId)) {
				candidateOrder.push(candidate.externalId);
				seenCandidateIds.add(candidate.externalId);
			}
			for (const alias of new Set([candidate.externalId, ...(candidate.identityAliases ?? [])])) {
				const candidateIds = candidateIdsByAlias.get(alias) ?? new Set<string>();
				candidateIds.add(candidate.externalId);
				candidateIdsByAlias.set(alias, candidateIds);
			}
		}

		const itemIdsByCandidate = new Map<string, Set<number>>();
		const aliases = [...candidateIdsByAlias.keys()];
		for (let offset = 0; offset < aliases.length; offset += IDENTITY_LOOKUP_CHUNK_SIZE) {
			const chunk = aliases.slice(offset, offset + IDENTITY_LOOKUP_CHUNK_SIZE);
			const placeholders = chunk.map(() => '?').join(',');
			const result = await this.db.prepare(`
				SELECT identity_value, item_id
				FROM item_identities
				WHERE identity_namespace = ? AND identity_value IN (${placeholders})
			`).bind(identityNamespace, ...chunk).all<IdentityMatchRow>();
			for (const row of result.results) {
				for (const candidateId of candidateIdsByAlias.get(row.identity_value) ?? []) {
					const itemIds = itemIdsByCandidate.get(candidateId) ?? new Set<number>();
					itemIds.add(row.item_id);
					itemIdsByCandidate.set(candidateId, itemIds);
				}
			}
		}

		const ambiguous = candidateOrder.filter((candidateId) => (
			(itemIdsByCandidate.get(candidateId)?.size ?? 0) > 1
		));
		if (ambiguous.length > 0) {
			throw new Error(
				`Ambiguous item identities for ${identityNamespace}: `
				+ `${ambiguous.length} candidate(s) matched multiple items`,
			);
		}

		return candidateOrder.flatMap((externalId) => {
			const itemId = itemIdsByCandidate.get(externalId)?.values().next().value;
			return itemId === undefined ? [] : [{ externalId, itemId }];
		});
	}

	async observeAndEnsureDeliveries(
		destinationKey: string,
		candidates: ResolvedItemCandidate[],
		now = currentUnixTime(),
		sourceId?: string,
	): Promise<number> {
		if (candidates.length === 0) return 0;
		const payload = resolvedCandidatePayload(candidates);
		const statements: D1PreparedStatement[] = [];
		if (sourceId) {
			statements.push(this.db.prepare(`
				INSERT INTO item_observations (
					connector_id, item_id, provider_item_id,
					first_observed_at, last_observed_at, metadata_json
				)
				SELECT
					connectors.id,
					CAST(json_extract(candidate.value, '$.itemId') AS INTEGER),
					CAST(json_extract(candidate.value, '$.externalId') AS TEXT),
					?, ?, '{}'
				FROM json_each(?) AS candidate
				JOIN source_connectors AS connectors ON connectors.connector_key = ?
				ON CONFLICT (connector_id, item_id) DO UPDATE SET
					last_observed_at = excluded.last_observed_at
				WHERE excluded.last_observed_at - item_observations.last_observed_at >= ?
			`).bind(now, now, payload, sourceId, OBSERVATION_REFRESH_SECONDS));
		}
		statements.push(this.db.prepare(`
			INSERT OR IGNORE INTO message_deliveries (
				item_id, destination_id, trigger_source_id,
				state, next_attempt_at, created_at, updated_at
			)
			SELECT DISTINCT
				CAST(json_extract(candidate.value, '$.itemId') AS INTEGER),
				destinations.id,
				connectors.source_id,
				'pending', ?, ?, ?
			FROM json_each(?) AS candidate
			JOIN destinations ON destinations.destination_key = ?
			LEFT JOIN source_connectors AS connectors ON connectors.connector_key = ?
		`).bind(
			now,
			now,
			now,
			payload,
			normalizeDestinationKey(destinationKey),
			sourceId ?? null,
		));
		const results = await this.db.batch(statements);
		return results[results.length - 1]?.meta.changes ?? 0;
	}

	async getOrCreateSourceProviderState(
		identityNamespace: string,
		checkpointKey: string,
		fallbackInitializedAt: number,
		overlapSeconds = 60,
		bootstrapUserName: string | null = null,
	): Promise<TwitterApiIoCheckpoint> {
		const existing = await this.getCheckpoint(checkpointKey);
		if (existing) return existing;
		const bootstrap = await this.db.prepare(`
			WITH latest AS (
				SELECT identities.identity_value, items.published_at
				FROM item_identities AS identities
				JOIN content_items AS items ON items.id = identities.item_id
				WHERE identities.identity_namespace = ?
					AND identities.identity_value GLOB 'twitter:[0-9]*'
					AND (
						? IS NULL
						OR instr(lower(COALESCE(items.url, '')), '/' || lower(?) || '/status/') > 0
					)
				ORDER BY (items.published_at IS NULL), items.published_at DESC, items.id DESC
				LIMIT 1
			)
			SELECT
				latest.identity_value AS high_water_identity,
				COALESCE(latest.published_at, ?) AS published_at
			FROM (SELECT 1)
			LEFT JOIN latest ON 1 = 1
		`).bind(
			identityNamespace,
			bootstrapUserName,
			bootstrapUserName,
			fallbackInitializedAt,
		).first<{ high_water_identity: string | null; published_at: number }>();
		if (!bootstrap) throw new Error(`Could not bootstrap checkpoint ${checkpointKey}`);

		await this.db.prepare(`
			INSERT OR IGNORE INTO source_connector_checkpoints (
				connector_id, initialized_at, high_water_identity, updated_at
			)
			SELECT id, ?, ?, unixepoch('now')
			FROM source_connectors
			WHERE connector_key = ?
		`).bind(
			Math.max(0, bootstrap.published_at - overlapSeconds),
			bootstrap.high_water_identity,
			checkpointKey,
		).run();
		const created = await this.getCheckpoint(checkpointKey);
		if (!created) throw new Error(`Missing v2 checkpoint ${checkpointKey}`);
		return created;
	}

	async updateSourceIngestionProgress(
		_identityNamespace: string,
		checkpointKey: string,
		previous: TwitterApiIoCheckpoint,
		progress: TwitterApiIoCheckpointProgress,
		now = currentUnixTime(),
	): Promise<void> {
		if (
			progress.highWaterExternalId === previous.highWaterExternalId
			&& progress.nextCursor === previous.nextCursor
			&& progress.pendingHighWaterExternalId === previous.pendingHighWaterExternalId
		) return;

		const result = await this.db.prepare(`
			UPDATE source_connector_checkpoints
			SET
				version = version + 1,
				high_water_identity = ?,
				cursor = ?,
				pending_high_water_identity = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND high_water_identity IS ?
				AND cursor IS ?
				AND pending_high_water_identity IS ?
		`).bind(
			progress.highWaterExternalId,
			progress.nextCursor,
			progress.pendingHighWaterExternalId,
			now,
			checkpointKey,
			previous.highWaterExternalId,
			previous.nextCursor,
			previous.pendingHighWaterExternalId,
		).run();
		if ((result.meta.changes ?? 0) !== 1) {
			throw new Error(`Checkpoint changed concurrently for ${checkpointKey}`);
		}
	}

	async claimDispatchable(now = currentUnixTime(), limit = 100): Promise<number[]> {
		const result = await this.db.prepare(`
			UPDATE message_deliveries
			SET state = 'queued', queued_at = ?, updated_at = ?
			WHERE id IN (
				SELECT id
				FROM message_deliveries
				WHERE state = 'pending' AND next_attempt_at <= ?
				ORDER BY next_attempt_at, id
				LIMIT ?
			)
			RETURNING id
		`).bind(now, now, now, limit).all<{ id: number }>();
		return result.results.map(({ id }) => id);
	}

	async releaseDispatchClaims(deliveryIds: number[], now = currentUnixTime()): Promise<void> {
		for (let offset = 0; offset < deliveryIds.length; offset += UPDATE_ID_CHUNK_SIZE) {
			const chunk = deliveryIds.slice(offset, offset + UPDATE_ID_CHUNK_SIZE);
			const placeholders = chunk.map(() => '?').join(',');
			await this.db.prepare(`
				UPDATE message_deliveries
				SET state = 'pending', queued_at = NULL, updated_at = ?
				WHERE id IN (${placeholders}) AND state = 'queued'
			`).bind(now, ...chunk).run();
		}
	}

	async acquireLease(
		deliveryId: number,
		leaseToken: string,
		now = currentUnixTime(),
		leaseSeconds = 120,
		maxAttempts = 5,
	): Promise<DeliveryLease | null> {
		const [claim, read] = await this.db.batch<DeliveryLeaseRow>([
			this.db.prepare(`
				UPDATE message_deliveries
				SET
					state = 'sending',
					attempt_count = attempt_count + 1,
					queued_at = NULL,
					lease_token = ?,
					lease_expires_at = ?,
					updated_at = ?
				WHERE id = ? AND attempt_count < ?
					AND (
						(state IN ('pending', 'queued') AND next_attempt_at <= ?)
						OR (state = 'sending' AND lease_expires_at <= ?)
					)
			`).bind(leaseToken, now + leaseSeconds, now, deliveryId, maxAttempts, now, now),
			this.db.prepare(`
				SELECT
					deliveries.id AS delivery_id,
					destinations.destination_key,
					deliveries.lease_token,
					deliveries.attempt_count,
					items.identity_namespace AS source_key,
					items.canonical_id AS external_id,
					items.title,
					items.description,
					CASE
						WHEN json_extract(items.metadata_json, '$.descriptionFormat') = 'telegram-html-v1'
							AND json_type(items.metadata_json, '$.telegramHtmlDescription') = 'text'
						THEN json_extract(items.metadata_json, '$.telegramHtmlDescription')
						ELSE NULL
					END AS formatted_description,
					items.url AS link,
					items.author_name AS author,
					items.image_url,
					items.published_at
				FROM message_deliveries AS deliveries
				JOIN content_items AS items ON items.id = deliveries.item_id
				JOIN destinations ON destinations.id = deliveries.destination_id
				WHERE deliveries.id = ? AND deliveries.lease_token = ?
			`).bind(deliveryId, leaseToken),
		]);
		if ((claim.meta.changes ?? 0) !== 1) return null;
		const row = read.results[0];
		return row ? mapLease(row) : null;
	}

	async getState(deliveryId: number): Promise<DeliveryState | null> {
		const row = await this.db.prepare(`
			SELECT id, state, attempt_count, next_attempt_at, lease_expires_at, last_error_code
			FROM message_deliveries WHERE id = ?
		`).bind(deliveryId).first<DeliveryStateRow>();
		if (!row) return null;
		return {
			id: row.id,
			status: row.state === 'pending'
				? (row.attempt_count > 0 || row.last_error_code ? 'retry' : 'ready')
				: row.state,
			attemptCount: row.attempt_count,
			availableAt: row.next_attempt_at,
			leaseExpiresAt: row.lease_expires_at,
		};
	}

	async markSent(
		deliveryId: number,
		leaseToken: string,
		providerMessageId: string | null,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE message_deliveries
			SET
				state = 'sent',
				lease_token = NULL,
				lease_expires_at = NULL,
				provider_message_id = ?,
				last_error_code = NULL,
				last_error = NULL,
				sent_at = ?,
				updated_at = ?
			WHERE id = ? AND state = 'sending' AND lease_token = ?
		`).bind(providerMessageId, now, now, deliveryId, leaseToken).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async releaseForQueueRetry(
		deliveryId: number,
		leaseToken: string,
		nextAttemptAt: number,
		errorCode: string,
		errorMessage: string,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE message_deliveries
			SET
				state = 'queued',
				next_attempt_at = ?,
				queued_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE id = ? AND state = 'sending' AND lease_token = ?
		`).bind(
			nextAttemptAt,
			now,
			errorCode,
			truncate(errorMessage),
			now,
			deliveryId,
			leaseToken,
		).run();
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
			UPDATE message_deliveries
			SET
				state = 'dead',
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE id = ? AND state = 'sending' AND lease_token = ?
		`).bind(errorCode, truncate(errorMessage), now, deliveryId, leaseToken).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async reconcileDeadLetter(
		deliveryId: number,
		maxAttempts: number,
		now = currentUnixTime(),
	): Promise<'dead' | 'retry' | null> {
		const state = await this.getState(deliveryId);
		if (!state || ['blocked', 'dead', 'sent'].includes(state.status)) return null;
		if (state.status === 'sending' && (state.leaseExpiresAt ?? 0) > now) return null;
		if (state.attemptCount >= maxAttempts) {
			const marked = await this.markDeadIfExhausted(
				deliveryId,
				maxAttempts,
				'DELIVERY_QUEUE_DEAD_LETTERED',
				'Cloudflare Queue retries were exhausted',
				now,
			);
			return marked ? 'dead' : null;
		}
		const result = await this.db.prepare(`
			UPDATE message_deliveries
			SET
				state = 'pending', queued_at = NULL,
				lease_token = NULL, lease_expires_at = NULL,
				next_attempt_at = ?, last_error_code = 'DELIVERY_QUEUE_RETRY',
				last_error = 'Retrying delivery after Queue DLQ reconciliation', updated_at = ?
			WHERE id = ? AND state IN ('pending', 'queued', 'sending')
		`).bind(now, now, deliveryId).run();
		return (result.meta.changes ?? 0) === 1 ? 'retry' : null;
	}

	async markDeadIfExhausted(
		deliveryId: number,
		maxAttempts: number,
		errorCode: string,
		errorMessage: string,
		now = currentUnixTime(),
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE message_deliveries
			SET
				state = 'dead', queued_at = NULL,
				lease_token = NULL, lease_expires_at = NULL,
				last_error_code = ?, last_error = ?, updated_at = ?
			WHERE id = ? AND attempt_count >= ?
				AND state IN ('pending', 'queued', 'sending')
				AND (state <> 'sending' OR lease_expires_at <= ?)
		`).bind(errorCode, truncate(errorMessage), now, deliveryId, maxAttempts, now).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async recoverStaleDeliveries(
		now = currentUnixTime(),
		queuedStaleSeconds = 172_800,
	): Promise<number> {
		const [sending, queued] = await this.db.batch([
			this.db.prepare(`
				UPDATE message_deliveries
				SET
					state = 'pending', lease_token = NULL, lease_expires_at = NULL,
					next_attempt_at = ?, last_error_code = 'DELIVERY_LEASE_EXPIRED',
					last_error = 'Previous delivery lease expired', updated_at = ?
				WHERE state = 'sending' AND lease_expires_at <= ?
			`).bind(now, now, now),
			this.db.prepare(`
				UPDATE message_deliveries
				SET
					state = 'pending', queued_at = NULL, next_attempt_at = ?,
					last_error_code = 'DELIVERY_QUEUE_STALE',
					last_error = 'Queued delivery exceeded the recovery threshold', updated_at = ?
				WHERE state = 'queued' AND queued_at <= ?
			`).bind(now, now, now - queuedStaleSeconds),
		]);
		return (sending.meta.changes ?? 0) + (queued.meta.changes ?? 0);
	}

	async compactDeliveredItems(retentionDays: number, now = currentUnixTime()): Promise<number> {
		const cutoff = now - retentionDays * 86_400;
		// Driven by idx_content_items_compactable so the sweep reads only items
		// that still hold content, not every delivery row ever written.
		const result = await this.db.prepare(`
			UPDATE content_items
			SET
				title = NULL, description = NULL, author_name = NULL,
				image_url = NULL, metadata_json = '{}', updated_at = ?
			WHERE (title IS NOT NULL OR description IS NOT NULL OR image_url IS NOT NULL)
				AND EXISTS (
					SELECT 1
					FROM message_deliveries
					WHERE message_deliveries.item_id = content_items.id
				)
				AND NOT EXISTS (
					SELECT 1
					FROM message_deliveries
					WHERE message_deliveries.item_id = content_items.id
						AND (
							message_deliveries.state NOT IN ('sent', 'dead', 'blocked')
							OR message_deliveries.updated_at > ?
						)
				)
		`).bind(now, cutoff).run();
		return result.meta.changes ?? 0;
	}

	async getSourceHttpCache(sourceId: string): Promise<SourceHttpCacheEntry> {
		const row = await this.db.prepare(`
			SELECT checkpoints.checkpoint_json
			FROM source_connector_checkpoints AS checkpoints
			JOIN source_connectors AS connectors ON connectors.id = checkpoints.connector_id
			WHERE connectors.connector_key = ?
		`).bind(sourceId).first<{ checkpoint_json: string }>();
		if (!row) return EMPTY_SOURCE_HTTP_CACHE_ENTRY;
		const parsed: unknown = JSON.parse(row.checkpoint_json);
		const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
		return {
			etag: typeof record.httpEtag === 'string' ? record.httpEtag : null,
			lastModified: typeof record.httpLastModified === 'string' ? record.httpLastModified : null,
		};
	}

	async setSourceHttpCache(
		sourceId: string,
		entry: SourceHttpCacheEntry,
		now = currentUnixTime(),
	): Promise<void> {
		const checkpointJson = JSON.stringify({
			...(entry.etag ? { httpEtag: entry.etag } : {}),
			...(entry.lastModified ? { httpLastModified: entry.lastModified } : {}),
		});
		await this.db.prepare(`
			INSERT INTO source_connector_checkpoints (
				connector_id, initialized_at, checkpoint_json, updated_at
			)
			SELECT connectors.id, sources.created_at, ?, ?
			FROM source_connectors AS connectors
			JOIN sources ON sources.id = connectors.source_id
			WHERE connectors.connector_key = ?
			ON CONFLICT (connector_id) DO UPDATE SET
				checkpoint_json = excluded.checkpoint_json,
				updated_at = excluded.updated_at
		`).bind(checkpointJson, now, sourceId).run();
	}

	private async getCheckpoint(checkpointKey: string): Promise<TwitterApiIoCheckpoint | null> {
		const row = await this.db.prepare(`
			SELECT
				checkpoints.initialized_at,
				checkpoints.high_water_identity,
				checkpoints.cursor,
				checkpoints.pending_high_water_identity,
				state.last_success_at
			FROM source_connector_checkpoints AS checkpoints
			JOIN source_connectors AS connectors ON connectors.id = checkpoints.connector_id
			LEFT JOIN source_connector_state AS state ON state.connector_id = connectors.id
			WHERE connectors.connector_key = ?
		`).bind(checkpointKey).first<CheckpointRow>();
		return row ? {
			highWaterExternalId: row.high_water_identity,
			initializedAt: row.initialized_at,
			lastSuccessfulPollAt: row.last_success_at,
			nextCursor: row.cursor,
			pendingHighWaterExternalId: row.pending_high_water_identity,
		} : null;
	}

	private insertDeliveriesStatement(
		identityNamespace: string,
		destinationKey: string,
		candidates: string,
		now: number,
		sourceId?: string,
	): D1PreparedStatement {
		return this.db.prepare(`
			WITH candidates AS MATERIALIZED (
				SELECT (
					SELECT items.id
					FROM content_items AS items
					WHERE items.identity_namespace = ?
						AND items.canonical_id = CAST(
							json_extract(candidate.value, '$.externalId') AS TEXT
						)
				) AS item_id
				FROM json_each(?) AS candidate
			)
			INSERT OR IGNORE INTO message_deliveries (
				item_id, destination_id, trigger_source_id,
				state, next_attempt_at, created_at, updated_at
			)
			SELECT
				candidates.item_id,
				destinations.id,
				connectors.source_id,
				'pending', ?, ?, ?
			FROM candidates
			JOIN destinations ON destinations.destination_key = ?
			LEFT JOIN source_connectors AS connectors ON connectors.connector_key = ?
		`).bind(
			identityNamespace,
			candidates,
			now,
			now,
			now,
			normalizeDestinationKey(destinationKey),
			sourceId ?? null,
		);
	}
}

function candidatePayload(items: CanonicalItem[]): string {
	return JSON.stringify(items.map((item) => ({
		externalId: item.externalId,
		aliases: [...new Set([item.externalId, ...(item.identityAliases ?? [])])],
		metadataJson: JSON.stringify(item.metadata ?? {}),
	})));
}

function resolvedCandidatePayload(items: ResolvedItemCandidate[]): string {
	return JSON.stringify(items.map(({ externalId, itemId }) => ({ externalId, itemId })));
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

function truncate(value: string): string {
	return value.slice(0, MAX_ERROR_LENGTH);
}

function currentUnixTime(): number {
	return Math.floor(Date.now() / 1_000);
}
