-- Migration number: 0005  Maintain TwitterAPI.io account subscriptions.
-- Subscription rows are operational data and must be inserted outside migrations.

CREATE TABLE twitter_subscriptions (
	id INTEGER PRIMARY KEY,
	provider_state_key TEXT NOT NULL UNIQUE
		CHECK (length(trim(provider_state_key)) > 0),
	user_name TEXT NOT NULL COLLATE NOCASE UNIQUE
		CHECK (
			length(trim(user_name)) > 0
			AND user_name = trim(user_name)
			AND instr(user_name, '@') = 0
			AND instr(user_name, '/') = 0
		),
	user_id TEXT
		CHECK (user_id IS NULL OR length(trim(user_id)) > 0),
	status TEXT NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'paused', 'archived')),
	poll_every_minutes INTEGER NOT NULL DEFAULT 5
		CHECK (poll_every_minutes BETWEEN 1 AND 60),
	include_replies INTEGER NOT NULL DEFAULT 0
		CHECK (include_replies IN (0, 1)),
	max_pages INTEGER NOT NULL DEFAULT 1
		CHECK (max_pages BETWEEN 1 AND 5),
	created_at INTEGER NOT NULL DEFAULT (unixepoch('now')),
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

CREATE UNIQUE INDEX idx_twitter_subscriptions_user_id
	ON twitter_subscriptions (user_id)
	WHERE user_id IS NOT NULL;

CREATE INDEX idx_twitter_subscriptions_status_poll
	ON twitter_subscriptions (status, poll_every_minutes, id);
