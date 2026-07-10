-- Migration number: 0003  Add durable item identity and delivery state.
-- This migration is additive so the previous Worker can still be rolled back.

CREATE TABLE items (
	id INTEGER PRIMARY KEY,
	source_key TEXT NOT NULL CHECK (length(source_key) > 0),
	external_id TEXT NOT NULL CHECK (length(external_id) > 0),
	title TEXT,
	description TEXT,
	link TEXT,
	author TEXT,
	image_url TEXT,
	published_at INTEGER,
	metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	UNIQUE (source_key, external_id)
);

CREATE TABLE deliveries (
	id INTEGER PRIMARY KEY,
	item_id INTEGER NOT NULL,
	destination_key TEXT NOT NULL CHECK (length(destination_key) > 0),
	status TEXT NOT NULL DEFAULT 'ready' CHECK (
		status IN ('ready', 'queued', 'sending', 'retry', 'sent', 'dead', 'blocked')
	),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	available_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	queued_at INTEGER,
	lease_token TEXT,
	lease_expires_at INTEGER,
	provider_message_id TEXT,
	last_error_code TEXT,
	last_error TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	sent_at INTEGER,
	FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE,
	UNIQUE (item_id, destination_key),
	CHECK (
		(status = 'sending' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
		OR
		(status <> 'sending' AND lease_token IS NULL AND lease_expires_at IS NULL)
	),
	CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX idx_items_source_published
	ON items (source_key, published_at DESC, id DESC);

CREATE INDEX idx_deliveries_dispatch
	ON deliveries (status, available_at, id);

CREATE INDEX idx_deliveries_lease
	ON deliveries (status, lease_expires_at, id);

CREATE INDEX idx_deliveries_destination_status
	ON deliveries (destination_key, status, updated_at);

-- Preserve legacy identities so deploying the new Worker does not resend old items.
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
		COALESCE(unixepoch(createdAt), unixepoch(pubDate), unixepoch('now')) AS created_at,
		COALESCE(
			unixepoch(updatedAt),
			unixepoch(createdAt),
			unixepoch(pubDate),
			unixepoch('now')
		) AS updated_at
	FROM pushed_items
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
FROM legacy;

-- A legacy pending row is ambiguous: Telegram may already have accepted it.
-- Keep it blocked instead of risking an automatic duplicate delivery.
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
		COALESCE(unixepoch(createdAt), unixepoch(pubDate), unixepoch('now')) AS created_at,
		COALESCE(
			unixepoch(updatedAt),
			unixepoch(createdAt),
			unixepoch(pubDate),
			unixepoch('now')
		) AS updated_at,
		CASE
			WHEN status = 'sent' THEN COALESCE(
				unixepoch(sentAt),
				unixepoch(updatedAt),
				unixepoch(createdAt),
				unixepoch(pubDate),
				unixepoch('now')
			)
			ELSE NULL
		END AS sent_at
	FROM pushed_items
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
	unixepoch('now'),
	legacy.last_error_code,
	legacy.last_error,
	legacy.created_at,
	legacy.updated_at,
	legacy.sent_at
FROM legacy
JOIN items
	ON items.source_key = legacy.source_key
	AND items.external_id = legacy.external_id;

-- Runtime reconciliation only needs legacy rows written after this additive
-- migration. A persistent cursor avoids scanning and rewriting the entire
-- rollback ledger on every minute-level Cron invocation.
CREATE TABLE migration_bridge_state (
	key TEXT PRIMARY KEY,
	value INTEGER NOT NULL
);

CREATE INDEX idx_pushed_items_updated_epoch
	ON pushed_items (unixepoch(updatedAt));

INSERT INTO migration_bridge_state (key, value)
VALUES ('legacy_reconciled_through', unixepoch('now'));
