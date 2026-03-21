CREATE TABLE pushed_items (
	id TEXT PRIMARY KEY,                -- 唯一标识符，优先使用 guid，缺失时回退为 link
	title TEXT,                         -- 标题
	description TEXT,                   -- 内容描述
	link TEXT,                          -- 文章链接
	pubDate TIMESTAMP,                  -- 发布时间
	source TEXT,                        -- 来源标识
	status TEXT NOT NULL DEFAULT 'sent',-- 投递状态：pending / sent / failed
	createdAt TIMESTAMP,                -- 记录创建时间
	updatedAt TIMESTAMP,                -- 最近状态更新时间
	sentAt TIMESTAMP,                   -- 实际发送成功时间
	lastError TEXT                      -- 最近一次失败原因
);

CREATE INDEX idx_pushed_items_source_status_pubdate
ON pushed_items (source, status, pubDate DESC);
