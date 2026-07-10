import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.toml',
      },
      miniflare: {
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000001',
          MIGRATION_DB: '00000000-0000-0000-0000-000000000002',
        },
        queueConsumers: {
          'telegram-delivery': {
            maxBatchSize: 10,
            maxBatchTimeout: 0.05,
            maxRetries: 5,
            deadLetterQueue: 'telegram-delivery-dlq',
          },
          'telegram-delivery-dlq': {
            maxBatchSize: 10,
            maxBatchTimeout: 0.05,
            maxRetries: 3,
          },
        },
        bindings: {
          IT_HOME_CHAT_ID: 'test-it-home-chat',
          TELEGRAM_BOT_TOKEN: 'test-telegram-token',
          TEST_MIGRATIONS: migrations,
          TWITTER_CHAT_ID: 'test-twitter-chat',
          TWITTER_RSS_URL: 'https://example.com/twitter.xml',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
    testTimeout: 5_000,
  },
});
