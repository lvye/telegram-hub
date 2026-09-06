# 清理复核记录

复核日期：2026-09-06。起点为 `60f964f`，初始工作区干净。交接文档作为候选问题清单，结论以当前代码、调用链、历史和实际测试为依据。

## 逐项结论

| 项目 | 结论、证据与最小改动 | 验证 |
| --- | --- | --- |
| A1 lint | **修复**。注入未处理的 `recoverStaleDeliveries()` 后，原 lint 退出 0。新增 `oxlint-tsgolint` 并启用 `--type-aware`，保留原来的 floating-promises 错误级别。 | 同一变异现在退出 1，精确报告 cleanup 的 no-floating-promises；恢复实现后通过。 |
| A2 测试专用状态方法 | **部分删除、部分保留**。`markFailed` 只有测试使用；删除并将其唯一剩余共享帮助函数内联至 `markBlocked`。保留多处测试使用的 `listDueSourceIds`、`claimForQueue`。 | 重写测试走 `claimDueSources → acquireQueuedLease → scheduleQueueRetry → markSucceeded`，验证失败累计、重试时间和令牌、成功清零。四项变异均失败。 |
| A3 RSS fallback | **删除**。旧历史 `a07d34d` 的环境变量路径曾配置 fallback；独立订阅及当前 D1 catalog 固定 null，当前运行时无法启用。删除分支、解码和配置字段，不新引入供应商切换行为。 | provider 失败原样上抛、不请求 RSS、不提交 checkpoint；原有分页与身份测试通过。 |
| A4 旧配置形状 | **删除**。旧 `TwitterApiIoSourceConfig` 的四字段只在接口及 fixture 使用，运行配置是其 Pick 子集。直接定义 `TwitterApiIoUserAdapterConfig`。 | TypeScript、catalog 与 TwitterAPI.io 测试。 |
| A5 DeliveryLease 字段 | **保留并使用身份字段**。生产消费者原未读取这三个字段。为 dead/retry 事件加入 sourceKey、externalId，便于追溯条目。publishedAt 随租约内容快照保留：单独收窄 DTO 和热路径 SELECT 收益有限。 | 投递 repository 与 queue 测试；未改变租约批量 SELECT、映射或状态转换。 |
| A6 ingestion 返回字段 | **删除**。唯一生产调用者只读 discovered/routedExisting，删除冗余 sourceId/sourceKey 返回字段；已有日志仍记录身份。 | TypeScript、ingestion 测试。 |
| A7 X entities 类型 | **删除**。与 B3 一并删除请求参数及未消费类型，保持两者一致。 | X 请求字段回归断言。 |
| A8 catalog.list | **保留**。domain 接口明确提供该方法，配置解码及拓扑测试使用；没有生产热路径调用不是必须删除的理由。 | 保留原覆盖，补上停用路由的 list/get 测试。 |
| A9 Node 类型 | **保留**。两个 smoke 脚本实际使用 node 模块；不能仅凭 tsconfig 未纳入全局类型判定开发依赖无用。 | smoke 脚本测试、TypeScript。 |
| A10 compiler 选项 | **保留**。暂时没有 JSON 导入或互操作需求不等于配置失效；没有足够收益支持改动。 | TypeScript。 |
| A11 导出面 | **保留**。这些是仍被本模块使用的代码与类型，不是死代码；本次不全面收窄模块接口。 | TypeScript。 |
| A12 缩进配置 | **修复**。JSON/JSONC/YAML 与 vitest.config.ts 实际用两空格，补 EditorConfig override。 | 与文件实际格式核对、diff 检查。 |
| A13 英文文档 | **修复**。补 Nitter adapter、connector key、TLS 行为及共享身份去重说明，与中文文档及实现一致。 | 路径、内容和链接检查。 |
| B1 DLQ 租约竞态 | **修复**。JS 读取与 UPDATE 之间可获得新租约；在 SQL 增加 sending 租约到期条件。 | 新测试在真实 D1 读取后插入真实 acquireLease，再继续对账；修复前返回 retry 导致失败，修复后不更新，且新 token 仍能 markSent。 |
| B2 Telegram 长度 | **修复**。X note_tweet 可把长文送入 title；formatter/client 原无整体限制。formatter 为原文链接预留空间，出站 client 再按正文 4096、caption 1024 限制解码后文本，保留合法 HTML 和省略号预算。原 160 描述预算不变。 | 超长标题、作者、旧纯文本描述、正文/图片说明、HTML 实体、emoji、嵌套标签及恰好上限；旁路限长函数导致 7 项失败。 |
| B3 X 多余字段 | **修复**。entities 无消费者，删除请求及类型，仅减少响应数据。X 按资源计费，不能据此宣称直接降低账单。 | 精确请求断言，重新加入 entities 的变异被捕获。 |

B2 对交接单的纠正：图片 caption 过长返回 400 时，原有 consumer 会尝试文本发送；只有回退文本也超限等情况才最终失败，并非所有 caption 超长都会直接 dead。

## 测试审计 C

通读原有 19 个 workerd 测试文件及 Node smoke 测试。未发现缺失 await、吞掉断言、恒真断言或 skip/todo。确认并修正两处名实不符：

1. catalog 的“排除停用路由”测试原只配置 paused connector。现在增加 active connector + paused route，验证 list 与 get；删除 route 状态过滤的变异被捕获。
2. X 用户 ID 缓存测试原只验证写入。现在再次加载缓存 ID，确认不重复 lookup/merge，不增加 lookup usage；忽略缓存的变异被捕获。

共完成 lint 变异前后对照、DLQ 修复前后对照，以及失败计数/令牌、catalog 路由、X 缓存/字段、Telegram 限长的定向变异。所有临时变异已还原。未对每一条现有测试执行全面变异；schema 索引测试仍验证测试中 SQL 的查询计划，不独立保证生产 SQL 后续修改也走同一索引。

## 验证记录

- 基线完整门禁成功是交接单的历史记录，本次未在起点重复全套；已独立复现 A1、B1。
- 定向测试：delivery repository/queue 23 项、runtime/ingestion queue 19 项、provider/catalog 29 项、Telegram 25 项通过。
- 沙箱内测试最初被 localhost 监听权限 EPERM 阻止；获准运行后正常执行。依赖下载首次受网络限制，重试成功。另一次并行测试遇到其他审计正在注入的路由变异；全部恢复后统一执行最终门禁。
- 最终 `npm run check` 退出 0：绑定类型、TypeScript、lint、20 文件 / 145 个 workerd 测试、3 个 smoke 脚本测试、dry bundle 全部通过。`git diff --check` 通过。
- 新启用的类型感知 lint 产生 5 条 `no-misused-spread` 警告（码点拆分不保证完整 grapheme cluster）。本项目此处有意按码点计数，不把它改成字形簇计数；无 lint error。
- 本机 Node.js 为 26.6.0；CI 声明的 Node.js 22 环境未另行复跑。未提交、push、迁移或部署。

## 外部依据

- [Oxlint 类型感知 lint](https://oxc.rs/docs/guide/usage/linter/type-aware.html)：需要额外依赖并启用 type-aware。
- [Telegram Bot API](https://core.telegram.org/bots/api#sendmessage)：正文 4096、[图片说明](https://core.telegram.org/bots/api#sendphoto) 1024，按实体解析后的字符计。
- [X fields](https://docs.x.com/x-api/fundamentals/fields)、[X pricing](https://docs.x.com/x-api/getting-started/pricing)：字段选择控制响应内容，读取按资源计费。

Telegram 计数依据：[TDLib 正文及 caption 校验](https://github.com/tdlib/td/blob/master/td/telegram/MessageContent.cpp) 使用 `utf8_length`；[其实现](https://github.com/tdlib/td/blob/master/tdutils/td/utils/utf8.h) 按 Unicode 码点计数，另行提供 UTF-16 长度函数。
