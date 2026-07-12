# Telegram Hub

[English](./README_EN.md)

基于 Cloudflare Workers 的 RSS / Nitter / TwitterAPI.io → Telegram 聚合器。Cron 只负责生成来源任务，D1 保存稳定 identity 和运行状态，Cloudflare Queues 负责异步采集、投递、退避重试和死信处理。

## 运行模型

```text
Cron (* * * * *)
  → D1 claim 到期 source
  → Ingestion Queue: sourceId + queueToken
  → D1 source lease
  → 抓取/解析 RSS，或调用 TwitterAPI.io
  → D1: content_items + message_deliveries (pending)
  → Delivery Queue: deliveryId
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

Worker 仅保留只读的 `GET /health` 和 `GET /health/ready`。readiness 会检查来源停更、blocked/dead 状态和 D1 可用性；生产环境不提供可触发推送的 HTTP 接口。

## 设计特点

- ES Module Worker + TypeScript，binding 类型由 `wrangler types` 生成
- 同一个 Worker 同时处理 `scheduled()`、`queue()` 和只读 `fetch()`
- Source Runtime 将 `sourceId`、adapter、identity namespace 和 destination 分离；Cron 直接在运行状态表中原子 claim 到期来源，Queue consumer 再通过 Catalog 点查单个来源并交给 adapter registry
- `source_connector_state` 保存 provider-neutral 的 cadence、租约、连续失败和下次轮询状态；`source_connector_checkpoints` 保存 provider checkpoint
- Cron 只按 `next_poll_at` 产生一个 source 一个 job；Ingestion Queue consumer 用 queue token 和 source lease 吸收重复或过期消息
- 来源 429/5xx 同时遵守 `Retry-After`、指数退避和 jitter；永久 4xx 进入 `blocked`，原生 ingestion DLQ 耗尽后写入 `dead`，两者在不同冷却期后自动探测恢复
- RSS、Nitter 与 TwitterAPI.io adapter 都输出 provider-neutral `CanonicalItem`，统一 ingestion service 负责去重、入库和 checkpoint 提交
- Telegram chat、parse mode 和 message format 属于独立 destination 配置，不再混入抓取 source
- 使用 `(identity_namespace, canonical_id)` 和独立的 `item_identities` 去重，不依赖发布时间水位
- Nitter、TwitterAPI.io 与旧 RSS 共用 `twitter` identity namespace；RSS 保留原 GUID，tweet status ID 负责跨 provider 去重
- 最新已知 RSS tweet identity 作为切换 high-water，避免墙钟 cutover 漏推；订阅表中的账号独立失败，不会重复抓取同一个 RSS fallback
- TwitterAPI.io 的 cursor、pending high-water 与 committed high-water 持久化到 D1；单轮达到 page budget 后下轮续拉
- 每个来源单轮最多接受 500 个原始候选和 1,000 个去重 identity alias；超限会标记为 `blocked`，避免无界结果持续消耗 D1 与 Queue
- 每轮最多持久化 50 个未见内容；带 checkpoint 的来源会在多轮排空 backlog 后才提交 checkpoint，不会因窗口限制跳过内容
- 已见 identity 通过 `(identity_namespace, identity_value)` 主键分块点查并复用解析结果，不再反复联结整张 identity 表
- 重复 Feed 对 `content_items/message_deliveries` 零写入，`item_observations` 最多每天刷新一次
- 使用 `(item_id, destination_key)` 独立跟踪每次投递
- D1 lease 支持中断后的安全重领
- Telegram 429 使用 Queue `delaySeconds` 重试，不在 Worker 中长时间 sleep
- 永久业务错误直接记录为 `dead`；未被 consumer 正常处理的消息由 Cloudflare 原生 DLQ 接管，未耗尽应用尝试时恢复为 `retry`
- 批量 D1 写入控制在 Workers Free 计划单次调用的查询预算内
- Ingestion Queue 每次只消费一个来源任务；delivery 统一由每分钟 Cron 调度，来源同步、故障恢复和 readiness 每 15 分钟错峰执行，避免全量 Catalog 解析和多 consumer 竞争入队
- `@cloudflare/vitest-pool-workers` 在真实 workerd 环境中测试 D1、Cron 和 Queue

## 项目结构

```text
src/
├── worker.ts                    # scheduled / queue / fetch 入口
├── config.ts                    # typed bindings 与 destination 配置
├── ingestion/                   # Source Catalog、adapter registry、规范化与编排
├── delivery/                    # Queue dispatcher/consumer、Telegram adapter
├── domain/                      # item/delivery 类型
├── persistence/                 # D1 状态机 repository
├── maintenance/                 # 终态内容压缩
├── parsers/                     # 数据源解析器
└── utils/                       # 文本与 XML 工具

migrations/                      # 生产 D1 schema 的唯一事实来源
test/                            # workerd 集成测试
```

## 部署

### 1. 安装依赖

```bash
npm ci
```

### 2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create telegram-hub-prod
npx wrangler queues create telegram-delivery
npx wrangler queues create telegram-delivery-dlq
npx wrangler queues create source-ingestion
npx wrangler queues create source-ingestion-dlq
```

将 D1 命令返回的 `database_id` 写入 `wrangler.toml` 的唯一 `DB` binding。Queue 名称已经在配置中声明。

### 3. 配置密钥

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put IT_HOME_CHAT_ID
npx wrangler secret put TWITTER_CHAT_ID
```

上述三个基础 binding 通过 `[secrets].required` 声明；缺失时部署会失败，而不是在 Cron 深层才报错。TwitterAPI.io key 是可选的，仅在启用相应 connector 时读取。

### Twitter provider 切换

Twitter 账号作为 D1 `sources` 和 `source_connectors` 运行数据维护，真实账号行不进入 Git。`source_connectors.adapter_key` 决定每个账号使用哪个 provider：

- `nitter.user-timeline`：逐账号请求 connector `config_json` 中的 `{baseUrl}/{userName}/rss`；
- `twitterapi-io.user-timeline`：使用 TwitterAPI.io adapter、checkpoint 和分页逻辑。

当前生产 connector 使用 `nitter.user-timeline` adapter。切换 provider 时应保留稳定的 `source_key`、`connector_key` 和 `identity_namespace`，仅更新 adapter/config；checkpoint 和跨 provider identity 不会丢失。Nitter adapter 对已配置的 HTTPS feed 使用受响应大小与超时限制的原生 TLS socket，并发送固定的只读 HTTP/1.1 GET。状态链接会规范化为 `x.com`，图片从 description HTML 提取。

### 可选：启用 TwitterAPI.io

API key 只保存在 Worker secret；账号及 provider 配置由 D1 的 `sources`、`source_connectors` 维护：

```bash
npx wrangler secret put TWITTERAPI_IO_API_KEY
```

通过 Cloudflare Dashboard 或一次性的 `wrangler d1 execute --remote --command` 事务更新运行数据，并同步维护 `source_routes`；不要把真实账号 INSERT 放进 migration、seed SQL 或其他 Git 跟踪文件。每个 connector 使用稳定 key、不带 `@` 的 `userName`、`active/paused/archived` 状态和独立轮询参数；暂停 connector 不会删除 cursor/high-water。

轮询间隔、page budget 和 replies 开关属于每个 connector 的 `poll_interval_seconds` / `config_json`，不再由全局 Worker binding 控制。每个 connector 使用独立、稳定的 checkpoint；若单次达到 page budget，下一次到期 Cron 会从 `source_connector_checkpoints` 中保存的 cursor 续拉。

TwitterAPI.io adapter 兼容常见媒体字段，并在必要时从明确的 tweet photo 页面读取 Open Graph 图片。该 endpoint 官方不建议高频轮询，调整 cadence/page budget 前请先评估调用成本。[接口文档](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)

选择 `twitterapi-io.user-timeline` 且缺少 API key 时会显式报配置错误。选择 `nitter.user-timeline` 时不会读取或调用 TwitterAPI.io。

### 4. 应用数据库迁移

```bash
npm run db:migrate:remote
```

`migrations` 创建规范化 topology、connector runtime/checkpoint、canonical content、provider observation 和 destination delivery 表。生产 Worker 只绑定并读写这一套 D1 schema。

### 5. 验证并部署

```bash
npm run check
npm run deploy
```

## 本地开发

```bash
cp .dev.vars.example .dev.vars
npm run cf:types:generate
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
npm run cf:types:check            # Cloudflare binding 类型
npm run ts:check                  # TypeScript
npm test                          # workerd tests
npm run db:schema:check           # schema、约束与索引计划
npm run db:migrate:local          # 当前数据库本地 migration
npm run db:migrations:list:remote # 当前数据库远端 migration 状态
npm run db:migrate:remote         # 当前数据库远端 migration（CI 使用）
npm run deploy:dry                # bundle + Workers 校验
npm run check                     # 完整检查
```

当前部署只绑定 `telegram-hub-prod` 为 `DB`。来源、运行状态、checkpoint、
canonical content 和投递状态均以该库为唯一事实来源。

## 添加数据源

1. 实现 `SourceAdapter`，直接输出 provider-neutral `CanonicalItem` 和可选 checkpoint transition。
2. 在 adapter registry 注册；`IngestionService` 不增加 provider `if/switch`。
3. 通过 `SourceCatalog` 生成稳定的 `sourceId`、`identityNamespace`、`destinationKey` 和 cadence。密钥只存在于运行时 adapter 配置，不写入持久化 job。
4. 新展示目标在 destination 配置和 formatter 中注册，不要把 chat 或 message format 放回 source。
5. provider 切换必须复用 identity namespace，并设计稳定 identity/cutover，不能直接把历史数据变成 ready delivery。
6. 添加 adapter contract 与 fixture 测试，覆盖分页预算、provider 去重、首次 cutover、延迟文章和 Telegram 格式化。

Feed parser 只解释来源格式；adapter 负责形成 canonical item，delivery 层负责最终 Telegram 格式并在发送边界重新校验富文本。

## 投递语义

Cloudflare Queues 是 at-least-once。consumer 会先检查 D1 终态并通过 lease 吸收绝大多数重复，但“Telegram 已成功、D1 标记 sent 前进程中断”仍可能导致极少量重复消息。这是外部 API 没有幂等键时无法完全消除的窗口。

`destinationKey` 是持久化投递身份。只更换 Telegram chat 时应保留原 key；新增 key 会为当前抓取窗口内已知 item 补建独立 delivery（RSS 每轮最多 50 条），可用于受控路由/backfill。不要让两个 key 指向同一 chat，除非明确接受重复展示。

Queue 的 `max_retries` / DLQ 处理基础设施级失败；Telegram 返回的 429、408 和 5xx 会由应用状态机按 `available_at` 退避后重新入队。400 等永久业务错误不会无意义地进入 DLQ。

## 许可证

MIT
