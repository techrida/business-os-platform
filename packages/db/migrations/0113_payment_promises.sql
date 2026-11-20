-- 0113_payment_promises: promises to pay (F1-Q33, decision D56). Finance or an Accountant records the date a customer
-- promised to pay an issued, unpaid invoice; the hourly payment-promise job marks a promise whose date has passed
-- while the invoice is still open as `missed` and plans ONE collection call (an app.activities follow-up on the
-- customer) for Finance. A promise whose invoice was settled by then is closed as `kept`. The receivables aging flags
-- a customer and currency that has a missed promise on an invoice still open.
--   * status: open -> missed | kept. Only an open promise changes; a missed or kept one is history.
--   * payment_promises_one_open_idx: one open promise per invoice. A new promise waits until the last one is missed
--     or kept.
--   * missed_at and collection_activity_id are set together when the job marks it missed. collection_activity_id has
--     no foreign key: app.activities has no (tenant_id, organization_id, id) key to point at, and the tenancy rule
--     wants every entity-to-entity key composite. The job writes both in one transaction.
--   * recorded_by_user_id: the staff user who recorded it (tenant-level FK into users, like activities').
--   * payment_promises_open_due_idx: the job's candidate read (open promises by promised date).
-- Entity-owned (tenant_id + organization_id), composite FKs, audited. No data: the table starts empty.
--
-- Runs as bos_owner, split at the breakpoint comments. No GRANT: 0008's default privileges cover new tables.

CREATE TABLE "app"."payment_promises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"promised_date" date NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"missed_at" timestamp with time zone,
	"collection_activity_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_promises_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_promises_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "payment_promises_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "payment_promises_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "payment_promises_recorded_by_fk" FOREIGN KEY ("tenant_id", "recorded_by_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "payment_promises_status_check" CHECK ("status" in ('open', 'missed', 'kept')),
	CONSTRAINT "payment_promises_note_check" CHECK ("note" IS NULL OR length("note") <= 1000),
	CONSTRAINT "payment_promises_missed_check" CHECK (("status" = 'missed') = ("missed_at" IS NOT NULL AND "collection_activity_id" IS NOT NULL)),
	CONSTRAINT "payment_promises_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_promises_one_open_idx" ON "app"."payment_promises" USING btree ("tenant_id", "organization_id", "invoice_id") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "payment_promises_tenant_org_invoice_idx" ON "app"."payment_promises" USING btree ("tenant_id", "organization_id", "invoice_id");
--> statement-breakpoint
CREATE INDEX "payment_promises_open_due_idx" ON "app"."payment_promises" USING btree ("promised_date") WHERE "status" = 'open';
--> statement-breakpoint
SELECT audit.attach('app.payment_promises');
