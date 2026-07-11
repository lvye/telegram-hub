-- Temporary blue/green migration cursor. This table is removed after the v2
-- cutover observation window; it is not part of the steady-state domain model.
CREATE TABLE schema_mirror_cursors (
	stream TEXT PRIMARY KEY CHECK (stream IN ('content_items', 'message_deliveries')),
	watermark_at INTEGER NOT NULL DEFAULT 0 CHECK (watermark_at >= 0),
	watermark_id INTEGER NOT NULL DEFAULT 0 CHECK (watermark_id >= 0),
	completed_at INTEGER,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch('now')) CHECK (updated_at >= 0)
);
