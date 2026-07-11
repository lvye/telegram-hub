-- Migration number: 0004  Track provider cutovers and cross-provider identity.

CREATE TABLE source_ingestion_state (
	source_key TEXT NOT NULL CHECK (length(source_key) > 0),
	provider TEXT NOT NULL CHECK (length(provider) > 0),
	initialized_at INTEGER NOT NULL,
	last_successful_poll_at INTEGER,
	high_water_external_id TEXT,
	next_cursor TEXT,
	pending_high_water_external_id TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (source_key, provider),
	CHECK (
		(next_cursor IS NULL AND pending_high_water_external_id IS NULL)
		OR
		(next_cursor IS NOT NULL AND pending_high_water_external_id IS NOT NULL)
	)
);

CREATE TABLE item_identity_aliases (
	source_key TEXT NOT NULL CHECK (length(source_key) > 0),
	alias TEXT NOT NULL CHECK (length(alias) > 0),
	item_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	PRIMARY KEY (source_key, alias),
	FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
);

CREATE INDEX idx_item_identity_aliases_item
	ON item_identity_aliases (item_id);

-- Existing external IDs remain aliases; Twitter source URLs additionally bridge
-- provider-specific RSS GUIDs to the API representation.
INSERT OR IGNORE INTO item_identity_aliases (source_key, alias, item_id)
SELECT source_key, external_id, id
FROM items;

INSERT OR IGNORE INTO item_identity_aliases (source_key, alias, item_id)
SELECT source_key, link, id
FROM items
WHERE source_key = 'TWITTER'
	AND link IS NOT NULL
	AND length(trim(link)) > 0;

-- Backfill a provider-independent tweet identity from legacy twitter.com/x.com
-- URLs. The recursive term reads only the leading numeric status ID, stopping
-- before query strings, fragments, or other URL suffixes.
WITH RECURSIVE twitter_status_ids (
	item_id,
	source_key,
	tweet_id,
	rest
) AS (
	SELECT
		id,
		source_key,
		'',
		substr(link, instr(link, '/status/') + length('/status/'))
	FROM items
	WHERE source_key = 'TWITTER'
		AND link IS NOT NULL
		AND instr(link, '/status/') > 0

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
INSERT OR IGNORE INTO item_identity_aliases (source_key, alias, item_id)
SELECT source_key, 'twitter:' || tweet_id, item_id
FROM twitter_status_ids
WHERE length(tweet_id) > 0
	AND (length(rest) = 0 OR substr(rest, 1, 1) NOT GLOB '[0-9]');
