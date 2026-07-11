# Telegram Hub

[English](./README_EN.md)

基于 Cloudflare Workers 的 RSS / TwitterAPI.io → Telegram 聚合器。Cron 只负责生成来源任务，D1 保存稳定 identity 和运行状态，Cloudflare Queues 负责异步采集、投递、退避重试和死信处理。

## 运行模型

```text
Cron (* * * * *)
  → D1 claim 到期 source
  → Ingestion Queue: sourceId + queueToken
  → D1 source lease
  → 抓取/解析 RSS，或调用 TwitterAPI.io
  → D1: items + deliveries (ready)
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
- Source Runtime 将 `sourceId`、adapter、identity namespace 和 destination 分离；Cron 只通过 Catalog 与 adapter registry 调度来源
- `source_runtime_state` 保存 provider-neutral 的 cadence、租约、连续失败和下次轮询状态；`source_ingestion_state` 只保存 provider checkpoint
- Cron 只按 `next_poll_at` 产生一个 source 一个 job；Ingestion Queue consumer 用 queue token 和 source lease 吸收重复或过期消息
- 来源 429/5xx 同时遵守 `Retry-After`、指数退避和 jitter；永久 4xx 进入 `blocked`，原生 ingestion DLQ 耗尽后写入 `dead`，两者在不同冷却期后自动探测恢复
- RSS、Nitter 与 TwitterAPI.io adapter 都输出 provider-neutral `CanonicalItem`，统一 ingestion service 负责去重、入库和 checkpoint 提交
- Telegram chat、parse mode 和 message format 属于独立 destination 配置，不再混入抓取 source
- 使用 `(source_key, external_id)` 去重，不依赖发布时间水位
- Nitter、TwitterAPI.io 与旧 RSS 共用 `TWITTER` identity alias；RSS 保留原 GUID，tweet status ID 负责跨 provider 去重
- 最新已知 RSS tweet identity 作为切换 high-water，避免墙钟 cutover 漏推；订阅表中的账号独立失败，不会重复抓取同一个 RSS fallback
- TwitterAPI.io 的 cursor、pending high-water 与 committed high-water 持久化到 D1；单轮达到 page budget 后下轮续拉
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
├── config.ts                    # typed bindings、source 输入与 destination 配置
├── ingestion/                   # Source Catalog、adapter registry、规范化与编排
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
npx wrangler queues create source-ingestion
npx wrangler queues create source-ingestion-dlq
```

将 D1 命令返回的 `database_id` 写入 `wrangler.toml`。Queue 名称已经在配置中声明。

### 3. 配置密钥

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put IT_HOME_CHAT_ID
npx wrangler secret put TWITTER_CHAT_ID
npx wrangler secret put TWITTER_RSS_URL
```

上述四个基础 binding 通过 `[secrets].required` 声明；缺失时部署会失败，而不是在 Cron 深层才报错。TwitterAPI.io binding 是可选的，便于保留凭据但通过 provider 开关暂停调用。

### Twitter provider 切换

Twitter 账号名单只维护在 D1 `twitter_subscriptions` 表中。`wrangler.toml` 的非敏感变量 `TWITTER_SOURCE_PROVIDER` 决定所有 `active` 账号使用哪个 provider：

- `nitter`：逐账号请求 `${NITTER_BASE_URL}/{user_name}/rss`，当前用于和 API 结果对比；
- `twitterapi-io`：恢复 TwitterAPI.io adapter、checkpoint 和分页逻辑。

当前仓库配置为 `nitter`。切换不会改动订阅数据、API secret 或跨 provider identity；catalog 同步会暂停不再出现的旧 runtime sources。Nitter adapter 使用浏览器请求头，规范化状态链接为 `x.com`，并从 description HTML 提取图片。首次启用会按账号已有 tweet high-water 建立独立 checkpoint，避免重推整段历史。

### 可选：启用 TwitterAPI.io

API key 只保存在 Worker secret；订阅账号由 D1 的 `twitter_subscriptions` 表维护：

```bash
npx wrangler secret put TWITTERAPI_IO_API_KEY
```

应用 migration 后，通过 Cloudflare Dashboard 或一次性的 `wrangler d1 execute --remote --command` 写入账号。不要把真实账号 INSERT 放进 migration、seed SQL 或其他 Git 跟踪文件。每行包含稳定的 `provider_state_key`、不带 `@` 的 `user_name`、`active/paused/archived` 状态和独立轮询参数；暂停账号不会删除其 cursor/high-water。

表为空时保留单次 RSS 行为；表存在订阅行时，由 `active` 行按当前 provider 展开 sources，多个账号仍共享 `TWITTER` item identity 和 Telegram destination。旧的 `TWITTERAPI_IO_USER_ID` / `TWITTERAPI_IO_USER_NAME` 单账号 binding 仍兼容，但不再是推荐配置。

可选调节项如下，默认每 5 分钟调用一次、每次 invocation 最多 1 页（每页最多 20 条）、不包含 replies：

```bash
npx wrangler secret put TWITTERAPI_IO_POLL_MINUTES
npx wrangler secret put TWITTERAPI_IO_MAX_PAGES
npx wrangler secret put TWITTERAPI_IO_INCLUDE_REPLIES
```

`0004` migration 会从历史 Twitter URL 回填 tweet status ID alias。`0005` 只创建订阅表结构，不包含任何账号数据。每个订阅使用独立、稳定的 provider state；首次启用只按该账号的历史 URL 初始化 high-water，避免错误引用其他账号的最新 tweet。若单次达到 page budget，下一次到期 Cron 会从 D1 中保存的 cursor 续拉。

TwitterAPI.io adapter 兼容常见媒体字段，并在必要时从明确的 tweet photo 页面读取 Open Graph 图片。该 endpoint 官方不建议高频轮询，调整 cadence/page budget 前请先评估调用成本。[接口文档](https://docs.twitterapi.io/api-reference/endpoint/get_user_last_tweets)

注意：一旦 TwitterAPI.io 已成功投递新 tweet，就不能再安全回滚到只理解 RSS provider GUID 的旧 Worker；此后应采用 roll-forward。订阅表为空时保持原 RSS 行为；选择 `twitterapi-io` 且存在 `active` 行但缺少 API key 时会显式报配置错误。选择 `nitter` 时不会读取或调用 TwitterAPI.io。

### 4. 应用数据库迁移

```bash
npx wrangler d1 migrations apply rss --remote
```

`0003` 会从旧的 `pushed_items` 回填新模型：

- `sent` → `sent`
- `failed` → `retry`
- 语义不确定的 `pending` → `blocked`，避免自动重发造成重复

`0004` 新增 provider handoff/pagination 状态与 `item_identity_aliases` 索引表，并从历史 Twitter URL 回填 tweet status ID，用于无漏推切换、可恢复分页和跨 provider 去重。

`0005` 新增 `twitter_subscriptions`，仅管理订阅配置；真实订阅行属于运行数据，不进入 Git。

迁移是 additive；观察期内旧表仍会保留。新 Worker 通过持久化 `updatedAt` 游标在投递前增量同步迁移后的旧记录，并在成功投递时同步更新旧 `pushed_items` sent ledger；每日 cleanup 继续按保留期清理旧表。因此，在 TwitterAPI.io 尚未实际投递新内容、且旧系统“GUID 全局唯一”的前提下，仍可回滚到旧 Worker。API 开始投递后须 roll-forward，因为旧 Worker 无法识别 API tweet ID 与 RSS provider GUID 的 alias 关系。不要在观察期内加入会产生跨来源同 GUID 的新源；旧 schema 无法表达这种 identity。

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
