-- 0015_crm: the CRM tables of P2 (plan unit S1; A2 section 2.1, revised by ADR 0027 and delta C-9).
--
-- Two scopes (ADR 0027 sections 6 and 8, and the "From P1" rules of the P2 build plan):
--   * Tenant-level (on check-tenancy's TENANT_SCOPED list): customers, customer_contacts, verification_cases.
--     tenant_id NOT NULL with its FK to app.tenants, no organization_id, unique keys led by tenant_id, and every
--     child FK carries tenant_id. A customer is one party for every legal entity of the tenant (D17 = A).
--   * Entity-owned: party_accounts, leads, opportunities, requirements, proposals, activities. tenant_id and
--     organization_id NOT NULL, (tenant_id, organization_id) -> organizations (<table>_tenant_org_fk), and a FK into
--     another entity-owned table is (tenant_id, organization_id, x). A FK into a tenant-level table (customers,
--     customer_contacts, users) is (tenant_id, x): parties are not composite on the entity (C-9).
--
-- customers.id is the party id. The FK (tenant_id, id, party_kind) -> parties (tenant_id, id, kind) runs through a
-- stored generated 'customer' column, as 0013 does for test_memos, so a vendor party can never be a customer.
-- PostgreSQL allows only NO ACTION on a FK that contains a generated column.
--
-- Columns that point at P2 tables created later (0016, plan unit S2) have no FK here; S2 adds them:
--   * party_accounts.payment_term_id       -> payment_terms (tenant_id, id)
--   * opportunities.won_quotation_version_id -> quotation_versions (tenant_id, organization_id, id)
--   * activities.quotation_id               -> quotations (tenant_id, organization_id, id)
--
-- Every table is audited (audit.attach). The tenant-level tables have no organization_id, so their events take
-- the acting entity (bos.organization_id, set by withTx). No GRANT: 0008's default privileges give bos_app
-- SELECT, INSERT, UPDATE, DELETE on new app tables.
-- row_version is the optimistic lock the API compares with the body's expectedVersion (the DTOs' `version`).
-- updated_at is set by the API, as on every kernel table.
--
-- DDL only: no row is written, so no actor context is needed. Runs as bos_owner, split at the breakpoint
-- comments (same rule as 0000). Names follow the K1-U2 convention, mirrored in src/schema/crm.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant-level tables
-- ---------------------------------------------------------------------------------------------------------------

-- A customer: the CRM record of a customer party. number is the display number (CUS-0001). name_norm is the
-- normalised legal name the API writes for duplicate search. pan_vat_no is stored upper-case, so the partial
-- unique index below holds whatever case the user typed. merged_into_id is set when this record was merged into
-- another one; the row stays, because quotations and the trail still name it.
CREATE TABLE "app"."customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_kind" text GENERATED ALWAYS AS ('customer') STORED,
	"number" text NOT NULL,
	"legal_name" text NOT NULL,
	"name_norm" text NOT NULL,
	"pan_vat_no" text,
	"industry" text,
	"relationship" text DEFAULT 'prospect' NOT NULL,
	"owner_user_id" uuid,
	"default_currency" char(3),
	"address" jsonb NOT NULL,
	"merged_into_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "customers_tenant_number_unique" UNIQUE("tenant_id", "number"),
	CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "customers_party_fk" FOREIGN KEY ("tenant_id", "id", "party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "customers_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "customers_merged_into_fk" FOREIGN KEY ("tenant_id", "merged_into_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "customers_relationship_check" CHECK ("relationship" in ('prospect', 'active', 'inactive')),
	CONSTRAINT "customers_default_currency_check" CHECK ("default_currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "customers_pan_vat_no_check" CHECK ("pan_vat_no" ~ '^[A-Z0-9-]{5,20}$'),
	CONSTRAINT "customers_address_check" CHECK (jsonb_typeof("address") = 'object'),
	CONSTRAINT "customers_merged_into_check" CHECK ("merged_into_id" <> "id"),
	CONSTRAINT "customers_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint

-- One PAN/VAT number per tenant; any number of customers without one. The same number may exist in two tenants.
CREATE UNIQUE INDEX "customers_tenant_pan_vat_no_unique" ON "app"."customers" USING btree ("tenant_id", "pan_vat_no") WHERE "pan_vat_no" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "customers_tenant_name_norm_idx" ON "app"."customers" USING btree ("tenant_id", "name_norm");
--> statement-breakpoint

-- A person at a customer. email_norm is lower-cased and trimmed, phone_e164 is E.164; both feed the duplicate
-- warning of lead conversion. (tenant_id, customer_id, id) lets a lead or an opportunity require that its contact
-- belongs to its customer.
CREATE TABLE "app"."customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email_norm" text,
	"phone_e164" text,
	"title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_contacts_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "customer_contacts_tenant_customer_id_unique" UNIQUE("tenant_id", "customer_id", "id"),
	CONSTRAINT "customer_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "customer_contacts_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "customer_contacts_email_norm_check" CHECK ("email_norm" = lower(btrim("email_norm"))),
	CONSTRAINT "customer_contacts_phone_e164_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "customer_contacts_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint

-- At most one primary contact per customer.
CREATE UNIQUE INDEX "customer_contacts_tenant_customer_primary_unique" ON "app"."customer_contacts" USING btree ("tenant_id", "customer_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "customer_contacts_tenant_email_norm_idx" ON "app"."customer_contacts" USING btree ("tenant_id", "email_norm");
--> statement-breakpoint
CREATE INDEX "customer_contacts_tenant_phone_e164_idx" ON "app"."customer_contacts" USING btree ("tenant_id", "phone_e164");
--> statement-breakpoint

-- The KYB (know your business) case of a customer: one per customer, tenant-level like the party it verifies.
-- checklist is the JSON array of ChecklistItem (contracts/crm.ts). An approved or rejected case names its reviewer
-- and decision time; a rejection needs a reason (the DTO's decisionNote).
CREATE TABLE "app"."verification_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reviewer_user_id" uuid,
	"decided_at" timestamp with time zone,
	"reason" text,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_cases_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "verification_cases_tenant_party_unique" UNIQUE("tenant_id", "party_id"),
	CONSTRAINT "verification_cases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "verification_cases_customer_fk" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "verification_cases_reviewer_user_fk" FOREIGN KEY ("tenant_id", "reviewer_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "verification_cases_status_check" CHECK ("status" in ('draft', 'submitted', 'approved', 'rejected', 'expired')),
	CONSTRAINT "verification_cases_checklist_check" CHECK (jsonb_typeof("checklist") = 'array'),
	CONSTRAINT "verification_cases_decision_check" CHECK ("status" NOT IN ('approved', 'rejected') OR ("reviewer_user_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
	CONSTRAINT "verification_cases_reason_check" CHECK ("status" <> 'rejected' OR "reason" IS NOT NULL),
	CONSTRAINT "verification_cases_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Entity-owned tables
-- ---------------------------------------------------------------------------------------------------------------

-- A customer's terms with one legal entity (ADR 0027 section 2, D17): owner, currency, payment term and credit
-- limit can differ per entity. credit_limit is in NPR, the base currency. payment_term_id gets its FK in 0016.
CREATE TABLE "app"."party_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"default_currency" char(3),
	"payment_term_id" uuid,
	"credit_limit" numeric(18, 2),
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_accounts_tenant_org_party_unique" UNIQUE("tenant_id", "organization_id", "party_id"),
	CONSTRAINT "party_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "party_accounts_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "party_accounts_customer_fk" FOREIGN KEY ("tenant_id", "party_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "party_accounts_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "party_accounts_default_currency_check" CHECK ("default_currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "party_accounts_credit_limit_check" CHECK ("credit_limit" >= 0),
	CONSTRAINT "party_accounts_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "party_accounts_tenant_party_idx" ON "app"."party_accounts" USING btree ("tenant_id", "party_id");
--> statement-breakpoint

-- A lead. Company and contact are free text until conversion links a customer and a contact (the contact must be
-- that customer's: the composite FK, plus a CHECK because MATCH SIMPLE skips the FK while customer_id is NULL).
-- Lost and On Hold need a reason and a note. Converted is set together with converted_opportunity_id (FK below,
-- after opportunities). number is the display number (LD-2026-0142), unique per entity like every series.
CREATE TABLE "app"."leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"campaign" text,
	"owner_user_id" uuid,
	"company_name" text NOT NULL,
	"contact_name" text NOT NULL,
	"email_norm" text,
	"phone_e164" text,
	"customer_id" uuid,
	"contact_id" uuid,
	"requirement" text,
	"expected_value" numeric(18, 2),
	"currency" char(3) DEFAULT 'NPR' NOT NULL,
	"probability" smallint,
	"expected_close" date,
	"next_follow_up_at" timestamp with time zone,
	"notes" text,
	"stage" text DEFAULT 'new' NOT NULL,
	"stage_reason" text,
	"stage_note" text,
	"converted_opportunity_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "leads_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "leads_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "leads_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "leads_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "leads_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "leads_contact_fk" FOREIGN KEY ("tenant_id", "customer_id", "contact_id") REFERENCES "app"."customer_contacts"("tenant_id", "customer_id", "id"),
	CONSTRAINT "leads_stage_check" CHECK ("stage" in ('new', 'contacted', 'qualified', 'converted', 'lost', 'on_hold')),
	CONSTRAINT "leads_source_check" CHECK ("source" in ('website', 'referral', 'cold_outreach', 'event', 'partner', 'social', 'walk_in', 'campaign', 'other')),
	CONSTRAINT "leads_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "leads_expected_value_check" CHECK ("expected_value" >= 0),
	CONSTRAINT "leads_probability_check" CHECK ("probability" BETWEEN 0 AND 100),
	CONSTRAINT "leads_email_norm_check" CHECK ("email_norm" = lower(btrim("email_norm"))),
	CONSTRAINT "leads_phone_e164_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "leads_contact_customer_check" CHECK ("contact_id" IS NULL OR "customer_id" IS NOT NULL),
	CONSTRAINT "leads_stage_reason_check" CHECK ("stage" NOT IN ('lost', 'on_hold') OR ("stage_reason" IS NOT NULL AND "stage_note" IS NOT NULL)),
	CONSTRAINT "leads_converted_check" CHECK (("stage" = 'converted') = ("converted_opportunity_id" IS NOT NULL)),
	CONSTRAINT "leads_converted_customer_check" CHECK ("stage" <> 'converted' OR "customer_id" IS NOT NULL),
	CONSTRAINT "leads_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "leads_tenant_org_stage_idx" ON "app"."leads" USING btree ("tenant_id", "organization_id", "stage");
--> statement-breakpoint
CREATE INDEX "leads_tenant_customer_idx" ON "app"."leads" USING btree ("tenant_id", "customer_id");
--> statement-breakpoint
CREATE INDEX "leads_tenant_email_norm_idx" ON "app"."leads" USING btree ("tenant_id", "email_norm");
--> statement-breakpoint
CREATE INDEX "leads_tenant_phone_e164_idx" ON "app"."leads" USING btree ("tenant_id", "phone_e164");
--> statement-breakpoint

-- An opportunity (a deal) with one customer. It starts at Qualified. Won is set only by the system, with the
-- accepted quotation version (FK in 0016). value is the expected deal value. number: DEAL-2026-0095.
CREATE TABLE "app"."opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"contact_id" uuid,
	"lead_id" uuid,
	"owner_user_id" uuid,
	"stage" text DEFAULT 'qualified' NOT NULL,
	"stage_reason" text,
	"stage_note" text,
	"value" numeric(18, 2),
	"currency" char(3) DEFAULT 'NPR' NOT NULL,
	"probability" smallint,
	"expected_close" date,
	"won_quotation_version_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "opportunities_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "opportunities_tenant_org_number_unique" UNIQUE("tenant_id", "organization_id", "number"),
	CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "opportunities_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "opportunities_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "opportunities_contact_fk" FOREIGN KEY ("tenant_id", "customer_id", "contact_id") REFERENCES "app"."customer_contacts"("tenant_id", "customer_id", "id"),
	CONSTRAINT "opportunities_lead_fk" FOREIGN KEY ("tenant_id", "organization_id", "lead_id") REFERENCES "app"."leads"("tenant_id", "organization_id", "id"),
	CONSTRAINT "opportunities_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "opportunities_stage_check" CHECK ("stage" in ('qualified', 'requirement_received', 'proposal_sent', 'quotation_sent', 'negotiation', 'won', 'lost', 'on_hold')),
	CONSTRAINT "opportunities_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "opportunities_value_check" CHECK ("value" >= 0),
	CONSTRAINT "opportunities_probability_check" CHECK ("probability" BETWEEN 0 AND 100),
	CONSTRAINT "opportunities_stage_reason_check" CHECK ("stage" NOT IN ('lost', 'on_hold') OR ("stage_reason" IS NOT NULL AND "stage_note" IS NOT NULL)),
	CONSTRAINT "opportunities_won_check" CHECK ("stage" <> 'won' OR "won_quotation_version_id" IS NOT NULL),
	CONSTRAINT "opportunities_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_org_stage_idx" ON "app"."opportunities" USING btree ("tenant_id", "organization_id", "stage");
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_customer_idx" ON "app"."opportunities" USING btree ("tenant_id", "customer_id");
--> statement-breakpoint
CREATE INDEX "opportunities_tenant_org_lead_idx" ON "app"."opportunities" USING btree ("tenant_id", "organization_id", "lead_id");
--> statement-breakpoint

-- leads and opportunities reference each other; this half waits until both exist (as 0014 does for documents).
-- MATCH SIMPLE: not checked while converted_opportunity_id is NULL.
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_converted_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "converted_opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id");
--> statement-breakpoint

-- What the customer asked for, on an opportunity. Files are kernel documents.
CREATE TABLE "app"."requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirements_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "requirements_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "requirements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "requirements_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "requirements_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id"),
	CONSTRAINT "requirements_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "requirements_tenant_org_opportunity_idx" ON "app"."requirements" USING btree ("tenant_id", "organization_id", "opportunity_id");
--> statement-breakpoint

-- An unpriced proposal document on an opportunity (A2 C11). It has no price column, ever: prices live only in
-- quotations. The file is a kernel document of the same entity (MATCH SIMPLE: not checked while NULL).
CREATE TABLE "app"."proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"title" text NOT NULL,
	"sent_at" timestamp with time zone,
	"document_id" uuid,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "proposals_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "proposals_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "proposals_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id"),
	CONSTRAINT "proposals_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "proposals_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "proposals_tenant_org_opportunity_idx" ON "app"."proposals" USING btree ("tenant_id", "organization_id", "opportunity_id");
--> statement-breakpoint

-- A call, meeting, email, note or task, or a server-written stage change or system entry. It hangs off exactly
-- one record: activities_one_subject_check counts the five subject columns, quotation_id included (its FK comes
-- in 0016). subject is a line of text, not the record.
CREATE TABLE "app"."activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"lead_id" uuid,
	"opportunity_id" uuid,
	"customer_id" uuid,
	"contact_id" uuid,
	"quotation_id" uuid,
	"due_at" timestamp with time zone,
	"assignee_user_id" uuid,
	"completed_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "activities_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "activities_lead_fk" FOREIGN KEY ("tenant_id", "organization_id", "lead_id") REFERENCES "app"."leads"("tenant_id", "organization_id", "id"),
	CONSTRAINT "activities_opportunity_fk" FOREIGN KEY ("tenant_id", "organization_id", "opportunity_id") REFERENCES "app"."opportunities"("tenant_id", "organization_id", "id"),
	CONSTRAINT "activities_customer_fk" FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "app"."customers"("tenant_id", "id"),
	CONSTRAINT "activities_contact_fk" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "app"."customer_contacts"("tenant_id", "id"),
	CONSTRAINT "activities_assignee_user_fk" FOREIGN KEY ("tenant_id", "assignee_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "activities_kind_check" CHECK ("kind" in ('call', 'meeting', 'email', 'note', 'task', 'stage_change', 'system')),
	CONSTRAINT "activities_one_subject_check" CHECK (num_nonnulls("lead_id", "opportunity_id", "customer_id", "contact_id", "quotation_id") = 1),
	CONSTRAINT "activities_row_version_check" CHECK ("row_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_lead_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "lead_id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_opportunity_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "opportunity_id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_customer_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "customer_id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_contact_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "contact_id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_quotation_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "quotation_id");
--> statement-breakpoint
CREATE INDEX "activities_tenant_org_assignee_due_idx" ON "app"."activities" USING btree ("tenant_id", "organization_id", "assignee_user_id", "due_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain. The tenant-level three take the acting entity.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.customers');
--> statement-breakpoint
SELECT audit.attach('app.customer_contacts');
--> statement-breakpoint
SELECT audit.attach('app.verification_cases');
--> statement-breakpoint
SELECT audit.attach('app.party_accounts');
--> statement-breakpoint
SELECT audit.attach('app.leads');
--> statement-breakpoint
SELECT audit.attach('app.opportunities');
--> statement-breakpoint
SELECT audit.attach('app.requirements');
--> statement-breakpoint
SELECT audit.attach('app.proposals');
--> statement-breakpoint
SELECT audit.attach('app.activities');
