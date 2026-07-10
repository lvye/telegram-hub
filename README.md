# Telegram Hub

[English](./README_EN.md)

基于 Cloudflare Workers 的 RSS → Telegram 聚合器。Cron 负责发现文章，D1 保存稳定 identity 和投递状态，Cloudflare Queues 负责异步投递、退避重试和死信处理。

## 运行模型

```text
Cron (* * * * *)
  → 抓取/解析 RSS
  → D1: items + deliveries (ready)
  → Queue: deliveryId
  → queue() consumer
  → D1 lease
  → Telegram Bot API
  → sent / delayed retry / dead

Queue 基础设施重试耗尽
  → 原生 DLQ consumer
  → D1 retry / dead（达到应用尝试上限）

Cron (0 4 * * *, UTC)
  → 压缩超过保留期的已终结内容，但保留 identity，避免旧文章重推
```

Worker 仅保留只读的 `GET /health`。生产环境不提供可触发推送的 HTTP 接口。

## 设计特点

- ES Module Worker + TypeScript，binding 类型由 `wrangler types` 生成
- 同一个 Worker 同时处理 `scheduled()`、`queue()` 和只读 `fetch()`
- 使用 `(source_key, external_id)` 去重，不依赖发布时间水位
- 扫描整个受 2 MB 上限保护的 Feed，每轮只写入最早的 50 个未见 identity；重复 Feed 对 `items/deliveries` 零写入，窗口外延迟文章会在后续轮次补入
- 使用 `(item_id, destination_key)` 独立跟踪每次投递
- D1 lease 支持中断后的安全重领
- Telegram 429 使用 Queue `delaySeconds` 重试，不在 Worker 中长时间 sleep
- 永久业务错误直接记录为 `dead`；未被 consumer 正常处理的消息由 Cloudflare 原生 DLQ 接管，未耗尽应用尝试时恢复为 `retry`
- 批量 D1 写入控制在 Workers Free 计划单次调用的查询预算内
- `@cloudflare/vitest-pool-workers` 在真实 workerd 环境中测试 D1、Cron 和 Queue

## 项目结构

```text
src/
├── worker.ts                    # scheduled / queue / fetch 入口
├── config.ts                    # typed bindings 与数据源配置
├── ingestion/                   # RSS 抓取、解析、规范化、持久化
├── delivery/                    # Queue dispatcher/consumer、Telegram adapter
├── domain/                      # item/delivery 类型
├── persistence/                 # D1 状态机 repository
├── maintenance/                 # 终态内容压缩
├── parsers/                     # 数据源解析器
└── utils/                       # 文本与 XML 工具

migrations/                      # D1 schema 的唯一事实来源
test/                            # workerd 集成测试
```

## 部署

### 1. 安装依赖

```bash
npm ci
```

### 2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create rss
npx wrangler queues create telegram-delivery
npx wrangler queues create telegram-delivery-dlq
```

将 D1 命令返回的 `database_id` 写入 `wrangler.toml`。Queue 名称已经在配置中声明。

### 3. 配置密钥

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put IT_HOME_CHAT_ID
npx wrangler secret put TWITTER_CHAT_ID
npx wrangler secret put TWITTER_RSS_URL
```

所有 binding 名称通过 `[secrets].required` 声明；缺失时部署会失败，而不是在 Cron 深层才报错。

### 4. 应用数据库迁移

```bash
npx wrangler d1 migrations apply rss --remote
```

`0003` 会从旧的 `pushed_items` 回填新模型：

- `sent` → `sent`
- `failed` → `retry`
- 语义不确定的 `pending` → `blocked`，避免自动重发造成重复

迁移是 additive；观察期内旧表仍会保留。新 Worker 通过持久化 `updatedAt` 游标在投递前增量同步迁移后的旧记录，并在成功投递时同步更新旧 `pushed_items` sent ledger；每日 cleanup 继续按保留期清理旧表。因此，对现有数据源且旧系统“GUID 全局唯一”的前提下，观察期内仍可回滚到旧 Worker。不要在观察期内加入会产生跨来源同 GUID 的新源；旧 schema 无法表达这种 identity。

如果切换过程要求尽可能接近零重复，应先暂停旧 Cron/Queue consumer，等待在途 invocation 结束，再应用迁移并部署。未暂停时仍存在旧、新 invocation 重叠的极小窗口。确认新版本稳定后，再通过独立迁移移除兼容桥和旧表。

### 5. 验证并部署

```bash
npm run check
npm run deploy
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run types
npm test
npm run dev
```

本地触发 Cron：

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*&format=json"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+4+*+*+*&format=json"
```

常用命令：

```bash
npm run typecheck     # TypeScript
npm test              # workerd tests
npm run deploy:dry    # bundle + Workers 校验
npm run check         # types + typecheck + tests + dry-run
```

## 添加数据源

1. 在 `src/parsers/` 添加返回规范化 Feed 字段的 parser。
2. 在 parser registry 注册。
3. 在 `src/config.ts` 添加 `SourceConfig`，为其分配稳定的 `sourceKey` 和 `destinationKey`。
4. 添加 fixture 测试，覆盖重复 GUID、延迟文章和 Telegram 格式化。

Parser 不生成 Telegram HTML；输出格式属于 delivery 层。

## 投递语义

Cloudflare Queues 是 at-least-once。consumer 会先检查 D1 终态并通过 lease 吸收绝大多数重复，但“Telegram 已成功、D1 标记 sent 前进程中断”仍可能导致极少量重复消息。这是外部 API 没有幂等键时无法完全消除的窗口。

Queue 的 `max_retries` / DLQ 处理基础设施级失败；Telegram 返回的 429、408 和 5xx 会由应用状态机按 `available_at` 退避后重新入队。400 等永久业务错误不会无意义地进入 DLQ。

## 许可证

MIT
