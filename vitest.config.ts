import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations('./migrations');
const v2Migrations = await readD1Migrations('./migrations_v2');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/worker.ts',
      miniflare: {
        compatibilityDate: '2026-07-10',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000001',
          DB_V2: '00000000-0000-0000-0000-000000000004',
          MIGRATION_DB: '00000000-0000-0000-0000-000000000002',
          SCHEMA_V2_DB: '00000000-0000-0000-0000-000000000003',
        },
        queueProducers: {
          INGESTION_QUEUE: 'source-ingestion',
          TELEGRAM_DELIVERY_QUEUE: 'telegram-delivery',
        },
        queueConsumers: {
          'source-ingestion': {
            maxBatchSize: 10,
            maxBatchTimeout: 0.05,
            maxRetries: 5,
            deadLetterQueue: 'source-ingestion-dlq',
          },
          'source-ingestion-dlq': {
            maxBatchSize: 10,
            maxBatchTimeout: 0.05,
            maxRetries: 3,
          },
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
          TEST_V2_MIGRATIONS: v2Migrations,
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
