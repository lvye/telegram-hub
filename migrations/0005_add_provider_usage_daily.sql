-- Keep provider billing estimates independently of content deduplication. One
-- row per connector, operation, UTC day, and unit price makes price changes
-- explicit while bounding write amplification and retention cost.

CREATE TABLE provider_usage_daily (
	usage_day TEXT NOT NULL CHECK (
		length(usage_day) = 10
		AND usage_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
	),
	connector_id INTEGER NOT NULL,
	provider_key TEXT NOT NULL CHECK (
		length(trim(provider_key)) > 0
		AND provider_key = lower(trim(provider_key))
	),
	operation_key TEXT NOT NULL CHECK (
		length(trim(operation_key)) > 0
		AND operation_key = lower(trim(operation_key))
	),
	request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
	resource_count INTEGER NOT NULL DEFAULT 0 CHECK (resource_count >= 0),
	billable_unit_count INTEGER NOT NULL DEFAULT 0 CHECK (billable_unit_count >= 0),
	unit_price_usd_micros INTEGER NOT NULL CHECK (unit_price_usd_micros >= 0),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (created_at >= 0),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= created_at),
	PRIMARY KEY (usage_day, connector_id, operation_key, unit_price_usd_micros),
	FOREIGN KEY (connector_id) REFERENCES source_connectors(id) ON DELETE RESTRICT
);

CREATE INDEX idx_provider_usage_daily_provider_day
	ON provider_usage_daily (provider_key, usage_day, connector_id);
