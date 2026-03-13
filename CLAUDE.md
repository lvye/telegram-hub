# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram Hub is a serverless RSS aggregator on Cloudflare Workers that fetches RSS feeds and pushes articles (with images) to Telegram channels via Bot API. Uses Cloudflare D1 (SQLite) for deduplication and state tracking.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Local dev server (wrangler dev)
npm run deploy       # Deploy to Cloudflare Workers
```

Database migrations:
```bash
wrangler d1 migrations apply rss --remote
```

There are no tests or lint commands configured.

## Architecture

**Entry point:** `src/index.js` — Cloudflare Worker with `scheduled()` (cron) and `fetch()` (HTTP) handlers.

**Cron flow:** Every minute triggers `handleRSSUpdate` → iterates configured sources → fetches feed → parses with source-specific parser → filters new items via DB → sends to Telegram → saves to DB. Daily cleanup deletes old records.

**Key modules:**
- `src/config/index.js` — RSS sources array (name, url, parser type, chatId, parseMode) and operational settings
- `src/handler/rss.js` — Main RSS processing orchestration
- `src/handler/cleanup.js` — Daily DB cleanup
- `src/parsers/` — Format-specific parsers (it-home, twitter) registered in `parsers/index.js`
- `src/services/telegram.js` — TelegramClient with retry (3 attempts) and rate-limit handling; sends photos with caption, falls back to text-only
- `src/services/database.js` — DatabaseService wrapping D1 queries
- `src/utils/xml-parser.js` — Regex-based XML parsing (not DOM-based), handles CDATA and namespaced tags

**Database:** Single `pushed_items` table (id, title, description, link, pubDate, source). Schema in `migrations/0001_initial_schema.sql`.

**Environment variables:** `TELEGRAM_BOT_TOKEN` (secret), `DB` (D1 binding) — configured in `wrangler.toml`.

## Code Style

- Tabs for indentation, single quotes, semicolons required, 140 char print width (see `.prettierrc`)
- Async/await throughout, no TypeScript
- Structured JSON logging via `src/utils/logger.js`
- Custom error class with codes in `src/utils/error-handler.js`

## Adding a New RSS Source

1. If the feed format needs special parsing, create a new parser in `src/parsers/` and register it in `src/parsers/index.js`
2. Add the source config to the `rss.sources` array in `src/config/index.js` with name, url, parser, chatId, and parseMode
