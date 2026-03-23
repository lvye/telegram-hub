-- Migration number: 0002 	 Add delivery state columns for atomic claim/send flow
ALTER TABLE pushed_items ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE pushed_items ADD COLUMN createdAt TIMESTAMP;
ALTER TABLE pushed_items ADD COLUMN updatedAt TIMESTAMP;
ALTER TABLE pushed_items ADD COLUMN sentAt TIMESTAMP;
ALTER TABLE pushed_items ADD COLUMN lastError TEXT;

-- Backfill existing rows: they were all successfully sent
UPDATE pushed_items SET
	createdAt = pubDate,
	updatedAt = pubDate,
	sentAt = pubDate
WHERE status = 'sent';

-- Index for the new query pattern
CREATE INDEX IF NOT EXISTS idx_pushed_items_source_status_pubdate
ON pushed_items (source, status, pubDate DESC);
