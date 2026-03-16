# Telegram Hub

[中文](./README.md)

A serverless RSS aggregator built on Cloudflare Workers that fetches RSS feeds and pushes articles (with images) to Telegram channels via Bot API. Uses Cloudflare D1 (SQLite) for deduplication and state tracking.

## Features

- Fetches RSS feeds every minute and pushes new articles to Telegram channels
- Supports photo messages with automatic image extraction
- Built-in deduplication to prevent duplicate pushes
- Independent configuration for multiple sources and channels
- Extensible parser architecture for easy adaptation to new RSS formats
- Daily automatic cleanup of old records

## Supported Sources

| Source | Parser | Description |
|--------|--------|-------------|
| IT Home | `it-home` | IT Home official RSS feed |
| Twitter | `twitter` | Twitter feed via rss.app |

## Project Structure

```
src/
├── config/                # Configuration
│   └── index.js           # Source and runtime settings
├── handlers/              # Business logic
│   ├── rss.js             # RSS fetch & push orchestration
│   └── cleanup.js         # Daily data cleanup
├── parsers/               # RSS parsers
│   ├── index.js           # Parser registry
│   ├── it-home.js         # IT Home parser
│   └── twitter.js         # Twitter parser
├── services/              # Service layer
│   ├── database.js        # D1 database operations
│   └── telegram.js        # Telegram Bot API client
├── utils/                 # Utilities
│   ├── error-handler.js   # Custom error handling
│   ├── logger.js          # Structured JSON logging
│   ├── text.js            # Text processing utilities
│   └── xml-parser.js      # Regex-based XML parsing
└── index.js               # Worker entry point (cron + HTTP)
```

## Deployment

### Prerequisites

1. Install [Node.js](https://nodejs.org/)
2. Install Wrangler CLI:
```bash
npm install -g wrangler
```
3. Log in to Cloudflare:
```bash
wrangler login
```

### Steps

**1. Clone the repository**

```bash
git clone https://github.com/lvye/telegram-hub
cd telegram-hub
npm install
```

**2. Create a D1 database**

```bash
wrangler d1 create rss
```

Copy the `database_id` from the output into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "rss"
database_id = "<your-database-id>"
```

**3. Run database migrations**

```bash
wrangler d1 migrations apply rss --remote
```

**4. Configure secrets**

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
```

Depending on your sources, you may also need these environment variables (set via Cloudflare Dashboard or `wrangler secret put`):

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token (required) |
| `IT_HOME_CHAT_ID` | Target channel ID for IT Home |
| `TWITTER_CHAT_ID` | Target channel ID for Twitter |
| `TWITTER_RSS_URL` | Twitter RSS feed URL |

**5. Configure sources**

Edit `src/config/index.js` and add or modify entries in the `sources` array:

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

**6. Deploy**

```bash
npm run deploy
```

## Adding a New Source

1. If the feed requires custom parsing, create a new parser in `src/parsers/` and register it in `src/parsers/index.js`
2. Add the source config to the `sources` array in `src/config/index.js` (type, name, url, parser, chatId, parseMode)

## Local Development

```bash
npm run dev    # Start local dev server
```

## License

This project is licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.
