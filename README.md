
# Telegram Hub

本项目基于 Cloudflare Workers，用于处理 RSS 源，并将其推送到 Telegram 频道。

---

## 项目来源
希望使用 Telegram 去阅读一些及时性的信息源，后期可以通过channel 的按钮反馈过滤掉不喜欢的信息。

## 项目说明
目前支持 IT Home 的 rss 源，以及基于 rss.app 的 Twitter 数据源。

## 文件结构

```
src/
├── config/                # 配置文件
│   ├── index.js           # 核心配置
│   └── validator.js       # 配置验证逻辑
├── parsers/               # 自定义 RSS 解析器
│   ├── index.js           # 解析器注册
│   ├── it-home.js         # IT之家解析器
│   └── twitter.js         # Twitter 解析器
├── services/              # 服务模块（Telegram、数据库）
│   ├── database.js        # 数据库交互逻辑
│   └── telegram.js        # Telegram API 客户端
├── utils/                 # 工具模块
│   ├── error-handler.js   # 错误处理
│   ├── logger.js          # 日志工具
│   └── xml-parser.js      # XML 解析工具
└── index.js               # Cloudflare Workers 入口文件
```

---


## 部署
### 环境准备

1. 安装 Node.js 和 npm。
2. 安装 `wrangler` CLI 工具：
```bash
npm install -g wrangler
```

### 部署步骤

1. 克隆本项目
```batch
git clone https://github.com/lvye/telegram-hub
cd telegram-hub
npm install
```

2. 创建 D1 数据库
```bash
wrangler d1 create rss
```

3. 将数据库绑定到项目
```bash
wrangler d1 bind rss
```  

4. 执行 SQL 迁移
```bash
wrangler d1 migrations apply rss --remote
```

5. 配置 `wrangler.toml` 文件，需要配置 `TELEGRAM_BOT_TOKEN`
```toml
name = "telegram-rss-bot"
main = "src/index.js"
compatibility_date = "2024-11-21"

[vars]
TELEGRAM_BOT_TOKEN = "<your_bot_token>"
DB = "rss"
```

6. 配置 rss 源和推送的 telegram channel 的 chatId

配置文件位于 `src/config/index.js`，示例配置如下：

```javascript
export const config = {
    rss: {
        sources: [
            {
                name: "IT_HOME",
                url: "https://www.ithome.com/rss/",
                parser: "it-home",
                chatId: "",
                parseMode: "HTML"
            },
            {
                name: "TWITTER",
                url: "https://rss.app/feeds/xxx.xml",
                parser: "twitter",
                chatId: "",
                parseMode: "HTML"
            }
        ],
        updateInterval: 60000, // 毫秒
        cleanupTime: 4         // 每日清理任务的时间(UTC)
    },
    telegram: {
        retryAttempts: 3,
        retryDelay: 1000,      // 毫秒
        rateLimitDelay: 1000   // 毫秒
    },
    database: {
        batchSize: 50          // 每次处理的记录数
    }
};
```

7. 部署项目：
```bash
wrangler deploy
```

## 许可证

本项目采用 MIT 许可证，详见 `LICENSE` 文件。
