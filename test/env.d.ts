import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      DB_V2: D1Database;
      MIGRATION_DB: D1Database;
      SCHEMA_V2_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      TEST_V2_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
