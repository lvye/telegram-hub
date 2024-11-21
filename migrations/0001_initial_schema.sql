-- Migration number: 0001 	 2024-11-12T08:31:55.361Z
CREATE TABLE pushed_items (
    id TEXT PRIMARY KEY,       -- 唯一标识符，使用 guid
    title TEXT,                -- 标题
    description TEXT,          -- 内容描述
    link TEXT,                 -- 文章链接
    pubDate TIMESTAMP,         -- 发布时间
    source TEXT                -- 来源
);