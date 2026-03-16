# Telegram Hub

[English](./README_EN.md)

基于 Cloudflare Workers 的无服务器 RSS 聚合器，自动抓取 RSS 源并将文章（含图片）推送到 Telegram 频道。使用 Cloudflare D1 (SQLite) 进行去重和状态追踪。

## 功能特点

- 每分钟自动抓取 RSS 源，推送新文章到 Telegram 频道
- 支持图文消息，自动提取文章配图
- 内置去重机制，避免重复推送
- 支持多数据源、多频道独立配置
- 可扩展的解析器架构，轻松适配新的 RSS 格式
- 每日自动清理历史记录

## 项目背景

希望通过 Telegram 阅读及时性信息源，后续可借助频道按钮反馈过滤不感兴趣的内容。

## 目前支持的数据源

| 数据源 | 解析器 | 说明 |
|--------|--------|------|
| IT之家 | `it-home` | IT之家官方 RSS |
| Twitter | `twitter` | 基于 rss.app 的 Twitter 数据源 |

## 项目结构

```
src/
├── config/                # 配置
│   └── index.js           # 数据源与运行参数配置
├── handlers/              # 业务处理
│   ├── rss.js             # RSS 抓取与推送主流程
│   └── cleanup.js         # 每日数据清理
├── parsers/               # RSS 解析器
│   ├── index.js           # 解析器注册表
│   ├── it-home.js         # IT之家解析器
│   └── twitter.js         # Twitter 解析器
├── services/              # 服务层
│   ├── database.js        # D1 数据库操作
│   └── telegram.js        # Telegram Bot API 客户端
├── utils/                 # 工具模块
│   ├── error-handler.js   # 自定义错误处理
│   ├── logger.js          # 结构化 JSON 日志
│   ├── text.js            # 文本处理工具
│   └── xml-parser.js      # 基于正则的 XML 解析
└── index.js               # Worker 入口（cron + HTTP）
```

## 部署

### 前置准备

1. 安装 [Node.js](https://nodejs.org/)
2. 安装 Wrangler CLI：
```bash
npm install -g wrangler
```
3. 登录 Cloudflare：
```bash
wrangler login
```

### 部署步骤

**1. 克隆项目**

```bash
git clone https://github.com/lvye/telegram-hub
cd telegram-hub
npm install
```

**2. 创建 D1 数据库**

```bash
wrangler d1 create rss
```

记录输出中的 `database_id`，填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "rss"
database_id = "<your-database-id>"
```

**3. 执行数据库迁移**

```bash
wrangler d1 migrations apply rss --remote
```

**4. 配置密钥**

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
```

根据数据源需要，还可配置以下环境变量（在 Cloudflare Dashboard 或通过 `wrangler secret put` 设置）：

| 变量名 | 说明 |
|--------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（必需） |
| `IT_HOME_CHAT_ID` | IT之家推送目标频道 ID |
| `TWITTER_CHAT_ID` | Twitter 推送目标频道 ID |
| `TWITTER_RSS_URL` | Twitter RSS 源地址 |

**5. 配置数据源**

编辑 `src/config/index.js`，在 `sources` 数组中添加或修改数据源：

```javascript
{
    type: 'rss',
    name: 'IT_HOME',
    url: 'https://www.ithome.com/rss/',
    parser: 'it-home',
    chatId: env.IT_HOME_CHAT_ID,
    parseMode: 'HTML',
}
```

**6. 部署**

```bash
npm run deploy
```

## 添加新数据源

1. 如果需要特殊的 Feed 解析逻辑，在 `src/parsers/` 下创建新解析器并在 `src/parsers/index.js` 中注册
2. 在 `src/config/index.js` 的 `sources` 数组中添加数据源配置（type、name、url、parser、chatId、parseMode）

## 本地开发

```bash
npm run dev    # 启动本地开发服务器
```

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](./LICENSE) 文件。
