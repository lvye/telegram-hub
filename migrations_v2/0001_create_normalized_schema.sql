-- Schema v2: provider-neutral sources, connector runtime, canonical content,
-- observations, and destination delivery state.

CREATE TABLE sources (
	id INTEGER PRIMARY KEY,
	source_key TEXT NOT NULL UNIQUE
		CHECK (length(trim(source_key)) > 0 AND source_key = lower(trim(source_key))),
	source_type TEXT NOT NULL
		CHECK (source_type IN ('rss_feed', 'twitter_user', 'twitter_list', 'twitter_search', 'webhook')),
	identity_namespace TEXT NOT NULL
		CHECK (
			length(trim(identity_namespace)) > 0
			AND identity_namespace = lower(trim(identity_namespace))
		),
	display_name TEXT,
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'archived')),
	settings_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(settings_json) AND json_type(settings_json) = 'object'),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at)
);

CREATE TABLE source_connectors (
	id INTEGER PRIMARY KEY,
	source_id INTEGER NOT NULL,
	connector_key TEXT NOT NULL UNIQUE
		CHECK (length(trim(connector_key)) > 0 AND connector_key = lower(trim(connector_key))),
	provider_key TEXT NOT NULL
		CHECK (length(trim(provider_key)) > 0 AND provider_key = lower(trim(provider_key))),
	adapter_key TEXT NOT NULL
		CHECK (length(trim(adapter_key)) > 0 AND adapter_key = lower(trim(adapter_key))),
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'archived')),
	poll_interval_seconds INTEGER NOT NULL CHECK (poll_interval_seconds > 0),
	config_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
	secret_ref TEXT CHECK (secret_ref IS NULL OR length(trim(secret_ref)) > 0),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT
);

CREATE TABLE source_connector_state (
	connector_id INTEGER PRIMARY KEY,
	state TEXT NOT NULL DEFAULT 'idle'
		CHECK (state IN ('idle', 'queued', 'running', 'blocked', 'dead')),
	next_run_at INTEGER NOT NULL CHECK (next_run_at >= 0),
	claim_token TEXT,
	claimed_at INTEGER,
	claim_expires_at INTEGER,
	failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
	last_attempt_at INTEGER,
	last_success_at INTEGER,
	last_error_code TEXT,
	last_error TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	FOREIGN KEY (connector_id) REFERENCES source_connectors(id) ON DELETE CASCADE,
	CHECK (
		(state IN ('queued', 'running')
			AND claim_token IS NOT NULL
			AND claimed_at IS NOT NULL
			AND claim_expires_at IS NOT NULL)
		OR
		(state NOT IN ('queued', 'running')
			AND claim_token IS NULL
			AND claimed_at IS NULL
			AND claim_expires_at IS NULL)
	)
);

CREATE TABLE source_connector_checkpoints (
	connector_id INTEGER PRIMARY KEY,
	version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
	initialized_at INTEGER NOT NULL CHECK (initialized_at >= 0),
	high_water_identity TEXT,
	cursor TEXT,
	pending_high_water_identity TEXT,
	checkpoint_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(checkpoint_json) AND json_type(checkpoint_json) = 'object'),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= 0),
	FOREIGN KEY (connector_id) REFERENCES source_connectors(id) ON DELETE CASCADE,
	CHECK (
		(cursor IS NULL AND pending_high_water_identity IS NULL)
		OR
		(cursor IS NOT NULL AND pending_high_water_identity IS NOT NULL)
	)
);

CREATE TABLE destinations (
	id INTEGER PRIMARY KEY,
	destination_key TEXT NOT NULL UNIQUE
		CHECK (
			length(trim(destination_key)) > 0
			AND destination_key = lower(trim(destination_key))
		),
	provider_key TEXT NOT NULL
		CHECK (length(trim(provider_key)) > 0 AND provider_key = lower(trim(provider_key))),
	adapter_key TEXT NOT NULL
		CHECK (length(trim(adapter_key)) > 0 AND adapter_key = lower(trim(adapter_key))),
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'archived')),
	config_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
	secret_ref TEXT CHECK (secret_ref IS NULL OR length(trim(secret_ref)) > 0),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at)
);

CREATE TABLE source_routes (
	source_id INTEGER NOT NULL,
	destination_id INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'archived')),
	filter_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(filter_json) AND json_type(filter_json) = 'object'),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	PRIMARY KEY (source_id, destination_id),
	FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT,
	FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE RESTRICT
);

CREATE TABLE content_items (
	id INTEGER PRIMARY KEY,
	identity_namespace TEXT NOT NULL
		CHECK (
			length(trim(identity_namespace)) > 0
			AND identity_namespace = lower(trim(identity_namespace))
		),
	canonical_id TEXT NOT NULL CHECK (length(trim(canonical_id)) > 0),
	title TEXT,
	description TEXT,
	url TEXT,
	author_name TEXT,
	image_url TEXT,
	published_at INTEGER,
	metadata_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	UNIQUE (identity_namespace, canonical_id)
);

CREATE TABLE item_identities (
	identity_namespace TEXT NOT NULL
		CHECK (
			length(trim(identity_namespace)) > 0
			AND identity_namespace = lower(trim(identity_namespace))
		),
	identity_value TEXT NOT NULL CHECK (length(trim(identity_value)) > 0),
	item_id INTEGER NOT NULL,
	identity_kind TEXT NOT NULL DEFAULT 'provider_id'
		CHECK (identity_kind IN ('canonical', 'provider_id', 'url')),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	PRIMARY KEY (identity_namespace, identity_value),
	FOREIGN KEY (item_id) REFERENCES content_items(id) ON DELETE CASCADE
);

CREATE TABLE item_observations (
	connector_id INTEGER NOT NULL,
	item_id INTEGER NOT NULL,
	provider_item_id TEXT NOT NULL CHECK (length(trim(provider_item_id)) > 0),
	first_observed_at INTEGER NOT NULL CHECK (first_observed_at >= 0),
	last_observed_at INTEGER NOT NULL CHECK (last_observed_at >= first_observed_at),
	metadata_json TEXT NOT NULL DEFAULT '{}'
		CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
	PRIMARY KEY (connector_id, item_id),
	UNIQUE (connector_id, provider_item_id),
	FOREIGN KEY (connector_id) REFERENCES source_connectors(id) ON DELETE CASCADE,
	FOREIGN KEY (item_id) REFERENCES content_items(id) ON DELETE CASCADE
);

CREATE TABLE message_deliveries (
	id INTEGER PRIMARY KEY,
	item_id INTEGER NOT NULL,
	destination_id INTEGER NOT NULL,
	trigger_source_id INTEGER,
	state TEXT NOT NULL DEFAULT 'pending'
		CHECK (state IN ('pending', 'queued', 'sending', 'sent', 'dead', 'blocked')),
	attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
	next_attempt_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (next_attempt_at >= 0),
	queued_at INTEGER,
	lease_token TEXT,
	lease_expires_at INTEGER,
	provider_message_id TEXT,
	last_error_code TEXT,
	last_error TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	sent_at INTEGER,
	FOREIGN KEY (item_id) REFERENCES content_items(id) ON DELETE RESTRICT,
	FOREIGN KEY (destination_id) REFERENCES destinations(id) ON DELETE RESTRICT,
	FOREIGN KEY (trigger_source_id) REFERENCES sources(id) ON DELETE SET NULL,
	UNIQUE (item_id, destination_id),
	CHECK (
		(state = 'queued' AND queued_at IS NOT NULL)
		OR (state <> 'queued' AND queued_at IS NULL)
	),
	CHECK (
		(state = 'sending' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
		OR (state <> 'sending' AND lease_token IS NULL AND lease_expires_at IS NULL)
	),
	CHECK ((state = 'sent' AND sent_at IS NOT NULL) OR (state <> 'sent' AND sent_at IS NULL))
);

CREATE INDEX idx_source_connectors_active_source
	ON source_connectors (source_id, id)
	WHERE status = 'active';

CREATE INDEX idx_source_connector_state_due
	ON source_connector_state (next_run_at, connector_id)
	WHERE state = 'idle';

CREATE INDEX idx_source_connector_state_claim_expiry
	ON source_connector_state (claim_expires_at, connector_id)
	WHERE state IN ('queued', 'running');

CREATE INDEX idx_source_connector_state_recovery
	ON source_connector_state (updated_at, connector_id)
	WHERE state IN ('blocked', 'dead');

CREATE INDEX idx_source_routes_active_destination
	ON source_routes (destination_id, source_id)
	WHERE status = 'active';

CREATE INDEX idx_content_items_namespace_published
	ON content_items (identity_namespace, published_at DESC, id DESC);

CREATE INDEX idx_item_identities_item
	ON item_identities (item_id);

CREATE INDEX idx_item_observations_item
	ON item_observations (item_id, connector_id);

CREATE INDEX idx_message_deliveries_dispatch
	ON message_deliveries (next_attempt_at, id)
	WHERE state = 'pending';

CREATE INDEX idx_message_deliveries_queue_recovery
	ON message_deliveries (queued_at, id)
	WHERE state = 'queued';

CREATE INDEX idx_message_deliveries_lease_recovery
	ON message_deliveries (lease_expires_at, id)
	WHERE state = 'sending';

CREATE INDEX idx_message_deliveries_sent_retention
	ON message_deliveries (sent_at, item_id)
	WHERE state = 'sent';
