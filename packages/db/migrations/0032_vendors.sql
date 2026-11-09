-- 0032_vendors: the vendor tables of P4 (plan unit S-V; premise corrections 1 and 3, AD9 and AD15 of the P4 plan).
--
-- A vendor is a party (ADR 0027), the vendor twin of 0015's customer: vendors.id is the party id. Two scopes, as in 0015:
--   * Tenant-level (on check-tenancy's TENANT_SCOPED list, which the lead extends): vendors, vendor_contacts,
--     vendor_bank_accounts. tenant_id NOT NULL with its FK to app.tenants, no organization_id, unique keys led by
--     tenant_id, and every child FK carries tenant_id. A vendor is one party for every legal entity of the tenant.
--     The bank accounts are tenant-level too, so "one active account per vendor" holds for the vendor, not per entity.
--   * Entity-owned: vendor_accounts (AD15, the twin of party_accounts). tenant_id and organization_id NOT NULL,
--     (tenant_id, organization_id) -> organizations, and a FK into a tenant-level table is (tenant_id, x): parties are
--     not composite on the entity (C-9). The FK columns are vendor_id, not vendor_party_id: that name is the portal
--     counterparty column of check-tenancy, which needs an FK to parties and a kind, and these tables are staff data.
--
-- vendors.id is the party id. The FK (tenant_id, id, party_kind) -> parties (tenant_id, id, kind) runs through a
-- stored generated 'vendor' column, as 0015 does for customers, so a customer party can never be a vendor.
-- PostgreSQL allows only NO ACTION on a FK that contains a generated column.
--
-- Maker-checker (AD9 and the vendor approval): vendors.approved_by is never the creator, and an approved vendor names
-- its approver. A bank account's verified_by is never its proposer, and an active account names its verifier and the
-- kernel document of the call-back evidence. The CHECKs read "<> proposed_by", which passes on NULL, so the
-- active-account CHECK is what makes a NULL verifier impossible on an active row.
--
-- vendor_bank_accounts.account_number_enc is the field-encrypted account number (K2 writes and reads it, the DTOs
-- show last4 only); account_fingerprint is the keyed hash K2 computes, for the duplicate-account search across vendors.
-- audit.attach below redacts account_number_enc: the ciphertext has no place in the hash chain.
--
-- Columns that point at tables of other units have no FK here:
--   * vendor_accounts.default_withholding_code_id -> withholding_codes (P3 U0-A creates it; S-AP adds the FK).
--
-- Every table is audited (audit.attach). The tenant-level tables have no organization_id, so their events take
-- the acting entity (bos.organization_id, set by withTx). No GRANT: 0008's default privileges give bos_app
-- SELECT, INSERT, UPDATE, DELETE on new app tables.
-- version is the optimistic lock (as on test_memos): updateVersioned() compares it with the body's expectedVersion.
-- updated_at is set by the API, as on every kernel table.
--
-- DDL only: no row is written, so no actor context is needed. Runs as bos_owner, split at the breakpoint
-- comments (same rule as 0000). Names follow the K1-U2 convention, mirrored in src/schema/vendors.ts.

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant-level tables
-- ---------------------------------------------------------------------------------------------------------------

-- A vendor: the procurement record of a vendor party. kind is the legal form; 'foreign' is a vendor outside Nepal
-- (country is then not NP, and the other way round), which has no PAN. Every other vendor has a nine-digit PAN,
-- stored as typed digits, so the partial unique index below holds. status follows the KYC flow of K3/V1.
-- legal_name is the name on the PAN certificate. created_by and approved_by are users of the tenant.
CREATE TABLE "app"."vendors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"party_kind" text GENERATED ALWAYS AS ('vendor') STORED,
	"legal_name" text NOT NULL,
	"kind" text DEFAULT 'company' NOT NULL,
	"pan" text,
	"vat_registered" boolean DEFAULT false NOT NULL,
	"country" char(2) DEFAULT 'NP' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"owner_user_id" uuid,
	"created_by" uuid NOT NULL,
	"approved_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendors_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "vendors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendors_party_fk" FOREIGN KEY ("tenant_id", "id", "party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "vendors_owner_user_fk" FOREIGN KEY ("tenant_id", "owner_user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendors_created_by_fk" FOREIGN KEY ("tenant_id", "created_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendors_approved_by_fk" FOREIGN KEY ("tenant_id", "approved_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendors_kind_check" CHECK ("kind" in ('company', 'proprietor', 'individual', 'foreign')),
	CONSTRAINT "vendors_status_check" CHECK ("status" in ('draft', 'pending_kyc', 'under_review', 'approved', 'suspended', 'blocked', 'archived')),
	CONSTRAINT "vendors_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "vendors_foreign_country_check" CHECK (("kind" = 'foreign') = ("country" <> 'NP')),
	CONSTRAINT "vendors_pan_check" CHECK ("kind" = 'foreign' OR ("pan" IS NOT NULL AND "pan" ~ '^[0-9]{9}$')),
	CONSTRAINT "vendors_pan_format_check" CHECK ("pan" ~ '^[A-Z0-9-]{5,20}$'),
	CONSTRAINT "vendors_approved_by_check" CHECK ("approved_by" <> "created_by"),
	CONSTRAINT "vendors_approval_check" CHECK ("status" <> 'approved' OR "approved_by" IS NOT NULL),
	CONSTRAINT "vendors_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- One PAN per tenant; any number of foreign vendors without one. The same PAN may exist in two tenants.
CREATE UNIQUE INDEX "vendors_tenant_pan_unique" ON "app"."vendors" USING btree ("tenant_id", "pan") WHERE "pan" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "vendors_tenant_status_idx" ON "app"."vendors" USING btree ("tenant_id", "status");
--> statement-breakpoint

-- A person at a vendor. email_norm is lower-cased and trimmed, phone_e164 is E.164 (as on customer_contacts).
CREATE TABLE "app"."vendor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"email_norm" text,
	"phone_e164" text,
	"title" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_contacts_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "vendor_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_contacts_vendor_fk" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "app"."vendors"("tenant_id", "id"),
	CONSTRAINT "vendor_contacts_email_norm_check" CHECK ("email_norm" = lower(btrim("email_norm"))),
	CONSTRAINT "vendor_contacts_phone_e164_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
	CONSTRAINT "vendor_contacts_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- At most one primary contact per vendor.
CREATE UNIQUE INDEX "vendor_contacts_tenant_vendor_primary_unique" ON "app"."vendor_contacts" USING btree ("tenant_id", "vendor_id") WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "vendor_contacts_tenant_vendor_idx" ON "app"."vendor_contacts" USING btree ("tenant_id", "vendor_id");
--> statement-breakpoint
CREATE INDEX "vendor_contacts_tenant_email_norm_idx" ON "app"."vendor_contacts" USING btree ("tenant_id", "email_norm");
--> statement-breakpoint

-- A bank account of a vendor, changed only through maker-checker (AD9). A new or changed account starts as
-- 'proposed' by one user (proposed_via says whether the vendor's portal user or staff typed it); a different user
-- verifies it after a call-back to the vendor, attaches the evidence document and makes it 'active'. The old active
-- account is retired in the same transaction (the partial unique index allows one active account per vendor).
-- A document of the evidence belongs to one entity, but the account does not, so the FK is (tenant_id, id).
-- last4 is the only part of the number a DTO shows.
CREATE TABLE "app"."vendor_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"account_name" text NOT NULL,
	"account_number_enc" bytea NOT NULL,
	"account_fingerprint" text NOT NULL,
	"last4" text NOT NULL,
	"currency" char(3) DEFAULT 'NPR' NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposed_via" text NOT NULL,
	"verified_by" uuid,
	"callback_evidence_document_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_bank_accounts_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "vendor_bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_bank_accounts_vendor_fk" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "app"."vendors"("tenant_id", "id"),
	CONSTRAINT "vendor_bank_accounts_proposed_by_fk" FOREIGN KEY ("tenant_id", "proposed_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bank_accounts_verified_by_fk" FOREIGN KEY ("tenant_id", "verified_by") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "vendor_bank_accounts_evidence_document_fk" FOREIGN KEY ("tenant_id", "callback_evidence_document_id") REFERENCES "app"."documents"("tenant_id", "id"),
	CONSTRAINT "vendor_bank_accounts_status_check" CHECK ("status" in ('proposed', 'active', 'retired', 'rejected')),
	CONSTRAINT "vendor_bank_accounts_proposed_via_check" CHECK ("proposed_via" in ('staff', 'portal')),
	CONSTRAINT "vendor_bank_accounts_currency_check" CHECK ("currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "vendor_bank_accounts_last4_check" CHECK ("last4" ~ '^[0-9]{4}$'),
	CONSTRAINT "vendor_bank_accounts_maker_checker_check" CHECK ("verified_by" <> "proposed_by"),
	CONSTRAINT "vendor_bank_accounts_active_check" CHECK ("status" <> 'active' OR ("verified_by" IS NOT NULL AND "callback_evidence_document_id" IS NOT NULL)),
	CONSTRAINT "vendor_bank_accounts_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint

-- One active account per vendor; any number of proposed, retired and rejected ones.
CREATE UNIQUE INDEX "vendor_bank_accounts_tenant_vendor_active_unique" ON "app"."vendor_bank_accounts" USING btree ("tenant_id", "vendor_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "vendor_bank_accounts_tenant_vendor_idx" ON "app"."vendor_bank_accounts" USING btree ("tenant_id", "vendor_id");
--> statement-breakpoint
CREATE INDEX "vendor_bank_accounts_tenant_fingerprint_idx" ON "app"."vendor_bank_accounts" USING btree ("tenant_id", "account_fingerprint");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Entity-owned table
-- ---------------------------------------------------------------------------------------------------------------

-- A vendor's terms with one legal entity (AD15, the vendor twin of party_accounts): currency and payment term can
-- differ per entity. active is false when the entity stops buying from the vendor. default_withholding_code_id has
-- its FK from S-AP. (tenant_id, organization_id, id) is the parent key for the later children (bills, POs).
CREATE TABLE "app"."vendor_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"default_currency" char(3),
	"payment_term_id" uuid,
	"default_withholding_code_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_accounts_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id"),
	CONSTRAINT "vendor_accounts_tenant_org_vendor_unique" UNIQUE("tenant_id", "organization_id", "vendor_id"),
	CONSTRAINT "vendor_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "vendor_accounts_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "vendor_accounts_vendor_fk" FOREIGN KEY ("tenant_id", "vendor_id") REFERENCES "app"."vendors"("tenant_id", "id"),
	CONSTRAINT "vendor_accounts_payment_term_fk" FOREIGN KEY ("tenant_id", "payment_term_id") REFERENCES "app"."payment_terms"("tenant_id", "id"),
	CONSTRAINT "vendor_accounts_default_currency_check" CHECK ("default_currency" in ('NPR', 'INR', 'USD')),
	CONSTRAINT "vendor_accounts_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE INDEX "vendor_accounts_tenant_vendor_idx" ON "app"."vendor_accounts" USING btree ("tenant_id", "vendor_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------------------------------------------
-- Audit: every write to these tables lands in the hash chain. The tenant-level three take the acting entity.
-- ---------------------------------------------------------------------------------------------------------------
SELECT audit.attach('app.vendors');
--> statement-breakpoint
SELECT audit.attach('app.vendor_contacts');
--> statement-breakpoint
SELECT audit.attach('app.vendor_bank_accounts', ARRAY['account_number_enc']);
--> statement-breakpoint
SELECT audit.attach('app.vendor_accounts');
