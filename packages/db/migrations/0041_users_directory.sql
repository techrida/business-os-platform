CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
ALTER TABLE app.users ADD COLUMN last_active_at timestamptz;
--> statement-breakpoint
CREATE INDEX users_display_name_trgm_idx ON app.users USING gin (display_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX users_email_trgm_idx ON app.users USING gin (email gin_trgm_ops);
--> statement-breakpoint
-- Activity is request telemetry. Keep actor checks for every write, but neither emit an event
-- for a heartbeat alone nor copy its timestamp into unrelated directory audit events.
SELECT audit.attach('app.users', '{last_active_at}', '{last_synced_at,last_active_at}');
