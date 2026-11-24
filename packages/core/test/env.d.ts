import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MEDIA_PUBLIC: R2Bucket;
      MEDIA_PRIVATE: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
