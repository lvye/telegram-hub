-- Migration number: 0006  Track provider-neutral source scheduling and execution state.

CREATE TABLE source_runtime_state (
	source_id TEXT PRIMARY KEY CHECK (length(trim(source_id)) > 0),
	adapter_key TEXT NOT NULL CHECK (length(trim(adapter_key)) > 0),
	identity_namespace TEXT NOT NULL CHECK (length(trim(identity_namespace)) > 0),
	destination_key TEXT NOT NULL CHECK (length(trim(destination_key)) > 0),
	poll_every_seconds INTEGER NOT NULL CHECK (poll_every_seconds > 0),
	status TEXT NOT NULL DEFAULT 'idle'
		CHECK (status IN ('idle', 'queued', 'running', 'backoff', 'blocked', 'dead', 'paused')),
	next_poll_at INTEGER NOT NULL CHECK (next_poll_at >= 0),
	queue_token TEXT,
	queued_at INTEGER,
	queue_expires_at INTEGER,
	lease_token TEXT,
	lease_expires_at INTEGER,
	consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	last_attempt_at INTEGER,
	last_success_at INTEGER,
	last_error_code TEXT,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK (
		(status = 'queued'
			AND queue_token IS NOT NULL
			AND queued_at IS NOT NULL
			AND queue_expires_at IS NOT NULL)
		OR
		(status <> 'queued'
			AND queue_token IS NULL
			AND queued_at IS NULL
			AND queue_expires_at IS NULL)
	),
	CHECK (
		(status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
		OR
		(status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
	)
);

CREATE INDEX idx_source_runtime_due
	ON source_runtime_state (status, next_poll_at, source_id);
