// drizzle-kit configuration (`pnpm --filter @bos/db generate`). Only `generate` is used: migrations are applied
// by src/migrate.ts, never by `drizzle-kit migrate` or `push`, so that one code path runs in dev, CI and prod.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/platform.ts',
  out: './migrations',
  // Only the schemas this package owns. Without this, drizzle-kit would also look at ZITADEL's tables.
  schemaFilter: ['app', 'ops'],
  dbCredentials: { url: process.env['DATABASE_MIGRATE_URL'] ?? '' },
});
