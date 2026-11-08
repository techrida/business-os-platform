-- 0005_notify: the in-app bell (notifications) and the email outbox (outbox).
-- Serves the Reliability NFR (a business action and its notice commit together, so neither is lost or sent
-- twice) and the Security NFR (email content is built from templates; this table never holds a token).
-- Plan: the P1 plan, section 4, "0005_notify".
--
-- Runs as bos_owner, in one transaction, split at the breakpoint comments (same rule as 0000).
-- Migration 0002 runs first and creates app.users, so the foreign keys to it need no guard.
--
-- Neither table gets audit.attach: both are on the check-audit allowlist. The business event that
-- creates a notification or an outbox row is already audited, and the outbox is rewritten on every retry.
-- bos_app keeps the default privileges from 0000 (select, insert, update, delete).

-- One row per person per event. dedupe_key is chosen by the caller (for example "approval.pending:<requestId>")
-- so a retried business action cannot notify the same user twice.
CREATE TABLE "app"."notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text NOT NULL,
	"read_at" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "notifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id"),
	CONSTRAINT "notifications_tenant_user_dedupe_unique" UNIQUE("tenant_id", "user_id", "dedupe_key")
);
--> statement-breakpoint

-- Serves the unread count and the "unread first" bell query.
CREATE INDEX "notifications_tenant_user_read_idx" ON "app"."notifications" USING btree ("tenant_id", "user_id", "read_at");
--> statement-breakpoint
-- Serves the inbox list (newest first, paged by created_at).
CREATE INDEX "notifications_tenant_user_created_idx" ON "app"."notifications" USING btree ("tenant_id", "user_id", "created_at" DESC);
--> statement-breakpoint

-- One row per email to send. The service writes it in the same transaction as the business change
-- (transactional outbox), and a worker sends it later, so a rolled-back change sends nothing.
-- dedupe_key is per recipient: the service builds it as `${dedupeKey}:${userId}`, so one event that
-- notifies three people makes three rows and a retried event makes none.
-- status: pending -> sending (claimed by a drainer, claimed_at set) -> sent, or dead after the last retry.
-- A row stuck in 'sending' with an old claimed_at is a crashed drainer; the drainer puts it back to pending.
CREATE TABLE "app"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"template" text NOT NULL,
	"to_user_id" uuid,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "outbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id"),
	CONSTRAINT "outbox_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "app"."users"("id"),
	CONSTRAINT "outbox_tenant_dedupe_unique" UNIQUE("tenant_id", "dedupe_key"),
	CONSTRAINT "outbox_kind_check" CHECK ("kind" in ('email')),
	CONSTRAINT "outbox_status_check" CHECK ("status" in ('pending', 'sending', 'sent', 'dead'))
);
--> statement-breakpoint

-- The drainer asks "what is due?" across all tenants, so this index does not lead with tenant_id.
-- Partial: sent and dead rows pile up and must not slow it down.
CREATE INDEX "outbox_pending_next_attempt_idx" ON "app"."outbox" USING btree ("next_attempt_at") WHERE "status" = 'pending';
--> statement-breakpoint
-- Serves stale-claim recovery (a 'sending' row whose drainer crashed).
CREATE INDEX "outbox_sending_claimed_idx" ON "app"."outbox" USING btree ("claimed_at") WHERE "status" = 'sending';
