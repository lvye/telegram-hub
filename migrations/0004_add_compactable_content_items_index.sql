-- Bound the daily compaction sweep to items that still hold content so its
-- cost tracks the uncompacted backlog instead of total table cardinality.

CREATE INDEX idx_content_items_compactable
	ON content_items (id)
	WHERE title IS NOT NULL OR description IS NOT NULL OR image_url IS NOT NULL;
