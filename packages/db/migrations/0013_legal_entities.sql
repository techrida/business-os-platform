-- 0013_legal_entities: organization_id is the legal entity; customers and vendors are parties (ADR 0027).
--
-- First half (K1-U1a), additive only:
--   * The bos.* actor context of this migration, so the audited UPDATEs below (and U1b's data move) are
--     written to the trail as system:migration-0013.
--   * The audit fallback of ADR 0027 section 6. Tenant-scoped tables (parties, idp_orgs, and later users and
--     user_roles) have no organization_id, so capture_row takes it from the row, else from bos.organization_id
--     (the transaction's acting entity), and still raises when both are missing. attach() requires only
--     tenant_id. The audit table and the hash are unchanged.
--   * organizations gains code, legal_name and is_default (section 2), backfilled for existing rows.
--   * The new tables parties, idp_orgs (section 2) and user_entities (section 3), each audited.
--   * The parent keys user_entities' composite FKs need: organizations (tenant_id, id), users (tenant_id, id),
--     departments (tenant_id, id) and (tenant_id, organization_id, id). 0014 must not add them again.
-- The second half (U1b) moves the data, drops kind and zitadel_org_id, and re-keys users and user_roles.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction. bos.tenant_id and bos.organization_id
-- are left unset: a statement that writes a tenant-scoped row must set the entity of that tenant first.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0013', true),
	set_config('bos.correlation_id', 'migration-0013:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

-- Same as 0008, except where organization_id comes from: the row, else bos.organization_id. The RAISE names
-- the table, so a tenant-scoped write outside withTx() (or before an entity exists) fails loudly.
CREATE OR REPLACE FUNCTION "audit"."capture_row"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
DECLARE
	v_redact text[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV[0]::text[] ELSE '{}'::text[] END;
	v_ignore text[] := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1]::text[] ELSE '{}'::text[] END;
	v_old jsonb;
	v_new jsonb;
	v_row jsonb;
	v_entity_id text;
	v_organization_id uuid;
BEGIN
	IF nullif(current_setting('bos.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'audit: bos.actor_id is not set; write to %.% through withTx()', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;

	IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;

	-- Nothing but ignored columns changed (e.g. a counter): no event.
	IF TG_OP = 'UPDATE' AND (v_old - v_ignore) = (v_new - v_ignore) THEN
		RETURN NULL;
	END IF;

	v_row := coalesce(v_new, v_old);

	-- An entity-owned row names its entity; a tenant-scoped row is recorded under the acting entity. An unset
	-- setting reads as NULL, or as '' once set_config has touched it on this pooled connection.
	v_organization_id := coalesce(
		(v_row ->> 'organization_id')::uuid,
		nullif(current_setting('bos.organization_id', true), '')::uuid);
	IF v_organization_id IS NULL THEN
		RAISE EXCEPTION 'audit: %.% row has no organization_id and bos.organization_id is not set; write through withTx() with an acting entity',
			TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;

	v_entity_id := v_row ->> 'id';
	IF v_entity_id IS NULL THEN
		-- No id column (e.g. a composite primary key): name the row by its primary-key values joined with '/'.
		SELECT string_agg(v_row ->> a.attname, '/' ORDER BY k.ord) INTO v_entity_id
		  FROM pg_catalog.pg_index i
		 CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
		  JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		 WHERE i.indrelid = TG_RELID AND i.indisprimary;
	END IF;

	PERFORM audit.append(
		(v_row ->> 'tenant_id')::uuid,
		v_organization_id,
		TG_TABLE_NAME || '.' || lower(TG_OP),
		TG_TABLE_NAME,
		coalesce(v_entity_id, ''),
		v_old - v_redact,
		v_new - v_redact,
		NULL
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Same as 0001 (with 0008's search_path), except that only tenant_id is required: a tenant-scoped table has
-- no organization_id and is audited through capture_row's fallback.
CREATE OR REPLACE FUNCTION "audit"."attach"(tbl regclass, redact text[] DEFAULT '{}', ignore text[] DEFAULT '{}')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
DECLARE
	v_schema text;
	v_table text;
	v_missing text;
BEGIN
	SELECT n.nspname, c.relname INTO v_schema, v_table
	  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
	 WHERE c.oid = tbl;

	-- A typo in a redact list would silently leak the column into the trail, so unknown names fail here.
	SELECT string_agg(col, ', ') INTO v_missing
	  FROM unnest(ARRAY['tenant_id'] || coalesce(redact, '{}') || coalesce(ignore, '{}')) AS col
	 WHERE NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_attribute a
		 WHERE a.attrelid = tbl AND a.attname = col AND a.attnum > 0 AND NOT a.attisdropped);
	IF v_missing IS NOT NULL THEN
		RAISE EXCEPTION 'audit.attach(%): no such column(s): %', tbl, v_missing;
	END IF;

	EXECUTE format('DROP TRIGGER IF EXISTS audit_capture ON %I.%I', v_schema, v_table);
	EXECUTE format(
		'CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
		'FOR EACH ROW EXECUTE FUNCTION audit.capture_row(%L, %L)',
		v_schema, v_table, coalesce(redact, '{}')::text, coalesce(ignore, '{}')::text);
END;
$$;
--> statement-breakpoint

-- CREATE OR REPLACE keeps the ACL (no PUBLIC EXECUTE since 0008, and bos_app never had these two). Said again
-- so that this file alone shows it.
REVOKE EXECUTE ON FUNCTION "audit"."capture_row"(), "audit"."attach"(regclass, text[], text[]) FROM PUBLIC;
--> statement-breakpoint

-- organizations = legal entities. The columns start nullable, are backfilled, then become NOT NULL.
ALTER TABLE "app"."organizations" ADD COLUMN "code" text;
--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD COLUMN "legal_name" text;
--> statement-breakpoint
ALTER TABLE "app"."organizations" ADD COLUMN "is_default" boolean DEFAULT false;
--> statement-breakpoint

-- Backfill (audited: organizations has the audit trigger, and the actor context is set above).
--   code: the name in upper case with every run of other characters as '-' ("Dev Customer Co" -> DEV-CUSTOMER-CO),
--         or the id when that is empty or not unique within the tenant. U1b may set the final codes.
--   legal_name: the name.
--   is_default: the tenant's staff org, the oldest one if a tenant has several, so the partial unique holds.
UPDATE "app"."organizations" o
   SET "code" = CASE WHEN c.slug <> '' AND c.n = 1 THEN c.slug ELSE o."id"::text END,
       "legal_name" = o."name",
       "is_default" = coalesce(o."id" = (
		SELECT d."id" FROM "app"."organizations" d
		 WHERE d."tenant_id" = o."tenant_id" AND d."kind" = 'staff'
		 ORDER BY d."created_at", d."id"
		 LIMIT 1), false)
  FROM (
	SELECT s."id", s.slug, count(*) OVER (PARTITION BY s."tenant_id", s.slug) AS n
	  FROM (
		SELECT "id", "tenant_id", upper(btrim(regexp_replace("name", '[^A-Za-z0-9]+', '-', 'g'), '-')) AS slug
		  FROM "app"."organizations"
	  ) s
  ) c
 WHERE c."id" = o."id";
--> statement-breakpoint

ALTER TABLE "app"."organizations" ALTER COLUMN "code" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."organizations" ALTER COLUMN "legal_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."organizations" ALTER COLUMN "is_default" SET NOT NULL;
--> statement-breakpoint

-- The seed upserts on (tenant_id, code).
ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_tenant_code_unique" UNIQUE("tenant_id", "code");
--> statement-breakpoint
-- At most one default entity per tenant (a partial unique index; PostgreSQL has no partial unique constraint).
CREATE UNIQUE INDEX "organizations_tenant_default_unique" ON "app"."organizations" USING btree ("tenant_id") WHERE "is_default";
--> statement-breakpoint

-- Parent keys of user_entities' composite FKs (ADR 0027 section 8).
ALTER TABLE "app"."organizations" ADD CONSTRAINT "organizations_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_tenant_id_unique" UNIQUE("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."departments" ADD CONSTRAINT "departments_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint

-- A customer or vendor company. Tenant-scoped (no organization_id): one party for every entity of the tenant.
-- (tenant_id, id, kind) is the target of the FKs that also check the kind (idp_orgs, the counterparty columns).
CREATE TABLE "app"."parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_tenant_code_unique" UNIQUE("tenant_id", "code"),
	CONSTRAINT "parties_tenant_id_kind_unique" UNIQUE("tenant_id", "id", "kind"),
	CONSTRAINT "parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "parties_kind_check" CHECK ("kind" in ('customer', 'vendor'))
);
--> statement-breakpoint

-- A ZITADEL organization (a login container). zitadel_org_id is unique across tenants: a token's org is
-- looked up before the tenant is known. The staff org has no party; a customer or vendor org has a party of
-- the same kind, because the FK includes kind. MATCH SIMPLE: a staff row (NULL party_id) is not checked.
CREATE TABLE "app"."idp_orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"zitadel_org_id" text NOT NULL,
	"kind" text NOT NULL,
	"party_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idp_orgs_zitadel_org_id_unique" UNIQUE("zitadel_org_id"),
	CONSTRAINT "idp_orgs_tenant_party_unique" UNIQUE("tenant_id", "party_id"),
	CONSTRAINT "idp_orgs_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "idp_orgs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "idp_orgs_tenant_party_kind_fk" FOREIGN KEY ("tenant_id", "party_id", "kind") REFERENCES "app"."parties"("tenant_id", "id", "kind"),
	CONSTRAINT "idp_orgs_kind_check" CHECK ("kind" in ('staff', 'customer', 'vendor')),
	CONSTRAINT "idp_orgs_party_check" CHECK (("kind" = 'staff') = ("party_id" IS NULL))
);
--> statement-breakpoint

-- One staff IdP org per tenant.
CREATE UNIQUE INDEX "idp_orgs_tenant_staff_unique" ON "app"."idp_orgs" USING btree ("tenant_id") WHERE "kind" = 'staff';
--> statement-breakpoint

-- Which entities a staff user may act for (entity-owned). role_keys NULL = every role in the token; a list
-- narrows them. The department belongs to one entity, so its FK includes organization_id (MATCH SIMPLE: not
-- checked while department_id is NULL).
CREATE TABLE "app"."user_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"role_keys" text[],
	"department_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_entities_tenant_org_user_unique" UNIQUE("tenant_id", "organization_id", "user_id"),
	CONSTRAINT "user_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "user_entities_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "user_entities_tenant_user_fk" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "app"."users"("tenant_id", "id"),
	CONSTRAINT "user_entities_tenant_org_department_fk" FOREIGN KEY ("tenant_id", "organization_id", "department_id") REFERENCES "app"."departments"("tenant_id", "organization_id", "id")
);
--> statement-breakpoint

-- At most one default entity per user.
CREATE UNIQUE INDEX "user_entities_tenant_user_default_unique" ON "app"."user_entities" USING btree ("tenant_id", "user_id") WHERE "is_default";
--> statement-breakpoint
CREATE INDEX "user_entities_tenant_user_idx" ON "app"."user_entities" USING btree ("tenant_id", "user_id");
--> statement-breakpoint

-- parties and idp_orgs have no organization_id: their events take the acting entity (capture_row above).
SELECT audit.attach('app.parties');
--> statement-breakpoint
SELECT audit.attach('app.idp_orgs');
--> statement-breakpoint
SELECT audit.attach('app.user_entities');

-- data move, drops and re-keying (K1-U1b) below
--> statement-breakpoint

-- Guards, while organizations.kind still exists. Each one RAISEs and rolls the whole migration back:
--   * a tenant that has organizations must have exactly one staff org. It becomes the default entity (the
--     audit fallback needs it), and idp_orgs allows one staff IdP org per tenant (idp_orgs_tenant_staff_unique).
--   * a row of any app table whose organization_id is a customer or vendor org. Only users (re-pointed), the
--     tenant-scoped tables that lose the column (user_roles, role_permissions, authz_versions, fx_rates) and
--     notifications, outbox and idempotency_keys (moved to the default entity) may hold such rows; organizations
--     itself is the org. Anything else is business data that a party cannot own: reset the dev database.
DO $$
DECLARE
	v_bad record;
	v_table text;
	v_found boolean;
BEGIN
	SELECT o."tenant_id", count(*) FILTER (WHERE o."kind" = 'staff') AS staff INTO v_bad
	  FROM "app"."organizations" o
	 GROUP BY o."tenant_id"
	HAVING count(*) FILTER (WHERE o."kind" = 'staff') <> 1
	 LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '0013: tenant % has % staff organizations, ADR 0027 needs exactly one (the default entity); reset the dev database',
			v_bad."tenant_id", v_bad.staff;
	END IF;

	FOR v_table IN
		SELECT c."table_name"
		  FROM "information_schema"."columns" c
		  JOIN "information_schema"."tables" t
		    ON t."table_schema" = c."table_schema" AND t."table_name" = c."table_name" AND t."table_type" = 'BASE TABLE'
		 WHERE c."table_schema" = 'app' AND c."column_name" = 'organization_id'
		   AND c."table_name" NOT IN ('organizations', 'users', 'user_roles', 'role_permissions', 'authz_versions',
		                              'fx_rates', 'notifications', 'outbox', 'idempotency_keys')
		 ORDER BY c."table_name"
	LOOP
		EXECUTE format(
			'SELECT EXISTS (SELECT 1 FROM app.%I x JOIN app.organizations o ON o.id = x.organization_id WHERE o.kind <> %L)',
			v_table, 'staff') INTO v_found;
		IF v_found THEN
			RAISE EXCEPTION '0013: app.% has rows owned by a customer or vendor organization, which becomes a party and cannot own them; reset the dev database',
				v_table;
		END IF;
	END LOOP;
END;
$$;
--> statement-breakpoint

ALTER TABLE "app"."users" ADD COLUMN "idp_org_id" uuid;
--> statement-breakpoint

-- The data move, one tenant at a time, under that tenant's default entity (the former staff org, same uuid):
--   * customer and vendor orgs become parties with the same uuid (their code from the backfill above);
--   * every former org becomes an idp_orgs row carrying its zitadel_org_id (staff: no party; customer and
--     vendor: their party);
--   * users point at the idp_org of their old org; staff users get a default membership in the default entity
--     with every token role (role_keys NULL) and their department; portal users get none.
-- parties and idp_orgs have no organization_id, so their audit events take bos.organization_id. It is reset to
-- '' after each tenant: a later tenant-scoped write without an entity must RAISE, not be audited under the
-- last tenant's entity.
DO $$
DECLARE
	v_tenant uuid;
	v_default uuid;
BEGIN
	FOR v_tenant, v_default IN
		SELECT o."tenant_id", o."id" FROM "app"."organizations" o WHERE o."is_default" ORDER BY o."tenant_id"
	LOOP
		PERFORM set_config('bos.organization_id', v_default::text, true);

		INSERT INTO "app"."parties" ("id", "tenant_id", "kind", "code", "name", "created_at", "updated_at")
		SELECT o."id", o."tenant_id", o."kind", o."code", o."name", o."created_at", o."created_at"
		  FROM "app"."organizations" o
		 WHERE o."tenant_id" = v_tenant AND o."kind" IN ('customer', 'vendor');

		INSERT INTO "app"."idp_orgs" ("tenant_id", "zitadel_org_id", "kind", "party_id", "name", "created_at")
		SELECT o."tenant_id", o."zitadel_org_id", o."kind", CASE WHEN o."kind" = 'staff' THEN NULL ELSE o."id" END,
		       o."name", o."created_at"
		  FROM "app"."organizations" o
		 WHERE o."tenant_id" = v_tenant;

		UPDATE "app"."users" u
		   SET "idp_org_id" = i."id"
		  FROM "app"."organizations" o
		  JOIN "app"."idp_orgs" i ON i."zitadel_org_id" = o."zitadel_org_id"
		 WHERE u."tenant_id" = v_tenant AND o."id" = u."organization_id" AND o."tenant_id" = v_tenant;

		INSERT INTO "app"."user_entities" ("tenant_id", "organization_id", "user_id", "is_default", "role_keys", "department_id")
		SELECT u."tenant_id", v_default, u."id", true, NULL, u."department_id"
		  FROM "app"."users" u
		  JOIN "app"."organizations" o ON o."id" = u."organization_id"
		 WHERE u."tenant_id" = v_tenant AND o."kind" = 'staff';

		PERFORM set_config('bos.organization_id', '', true);
	END LOOP;
END;
$$;
--> statement-breakpoint

-- A user whose old org is in another tenant has no idp_org now. SET NOT NULL below would fail too, with a less
-- helpful message.
DO $$
DECLARE
	v_user uuid;
BEGIN
	SELECT u."id" INTO v_user FROM "app"."users" u WHERE u."idp_org_id" IS NULL LIMIT 1;
	IF FOUND THEN
		RAISE EXCEPTION '0013: user % has no organization in its own tenant to take an IdP org from; reset the dev database', v_user;
	END IF;
END;
$$;
--> statement-breakpoint

-- Dedupe before the tenant-scoped keys: of rows that would share the new key (the same role permission, FX rate
-- or authz version in two orgs of one tenant), keep the default entity's (the staff org's), else the oldest.
-- user_roles needs none: its old primary key (user_id, role_key) is already unique, and a user has one tenant.
DELETE FROM "app"."role_permissions" r
 USING (
	SELECT x."id", row_number() OVER (
		PARTITION BY x."tenant_id", x."role_key", x."permission"
		ORDER BY coalesce(d."is_default", false) DESC, x."created_at", x."id") AS rn
	  FROM "app"."role_permissions" x
	  LEFT JOIN "app"."organizations" d ON d."id" = x."organization_id"
 ) k
 WHERE r."id" = k."id" AND k.rn > 1;
--> statement-breakpoint
DELETE FROM "app"."fx_rates" r
 USING (
	SELECT x."id", row_number() OVER (
		PARTITION BY x."tenant_id", x."currency", x."rate_date"
		ORDER BY coalesce(d."is_default", false) DESC, x."created_at", x."id") AS rn
	  FROM "app"."fx_rates" x
	  LEFT JOIN "app"."organizations" d ON d."id" = x."organization_id"
 ) k
 WHERE r."id" = k."id" AND k.rn > 1;
--> statement-breakpoint
DELETE FROM "app"."authz_versions" r
 USING (
	SELECT x."id", row_number() OVER (
		PARTITION BY x."tenant_id"
		ORDER BY coalesce(d."is_default", false) DESC, x."updated_at", x."id") AS rn
	  FROM "app"."authz_versions" x
	  LEFT JOIN "app"."organizations" d ON d."id" = x."organization_id"
 ) k
 WHERE r."id" = k."id" AND k.rn > 1;
--> statement-breakpoint

-- Event rows of a customer or vendor org move to the default entity (ADR 0027 section 10). idempotency_keys is
-- audited; the row names its (new) entity.
UPDATE "app"."notifications" x
   SET "organization_id" = d."id"
  FROM "app"."organizations" o
  JOIN "app"."organizations" d ON d."tenant_id" = o."tenant_id" AND d."is_default"
 WHERE o."id" = x."organization_id" AND o."kind" <> 'staff';
--> statement-breakpoint
UPDATE "app"."outbox" x
   SET "organization_id" = d."id"
  FROM "app"."organizations" o
  JOIN "app"."organizations" d ON d."tenant_id" = o."tenant_id" AND d."is_default"
 WHERE o."id" = x."organization_id" AND o."kind" <> 'staff';
--> statement-breakpoint
UPDATE "app"."idempotency_keys" x
   SET "organization_id" = d."id"
  FROM "app"."organizations" o
  JOIN "app"."organizations" d ON d."tenant_id" = o."tenant_id" AND d."is_default"
 WHERE o."id" = x."organization_id" AND o."kind" <> 'staff';
--> statement-breakpoint

-- user_roles, role_permissions, authz_versions and fx_rates become tenant-scoped (section 6): organization_id
-- goes, and the keys are re-led by tenant_id.
ALTER TABLE "app"."user_roles" DROP CONSTRAINT "user_roles_user_id_role_key_pk";
--> statement-breakpoint
ALTER TABLE "app"."user_roles" DROP CONSTRAINT "user_roles_organization_id_organizations_id_fk";
--> statement-breakpoint
DROP INDEX "app"."user_roles_tenant_org_role_idx";
--> statement-breakpoint
ALTER TABLE "app"."user_roles" DROP COLUMN "organization_id";
--> statement-breakpoint
ALTER TABLE "app"."user_roles" ADD CONSTRAINT "user_roles_tenant_id_user_id_role_key_pk" PRIMARY KEY("tenant_id", "user_id", "role_key");
--> statement-breakpoint
CREATE INDEX "user_roles_tenant_role_idx" ON "app"."user_roles" USING btree ("tenant_id", "role_key");
--> statement-breakpoint

ALTER TABLE "app"."role_permissions" DROP CONSTRAINT "role_permissions_tenant_org_role_permission_unique";
--> statement-breakpoint
ALTER TABLE "app"."role_permissions" DROP CONSTRAINT "role_permissions_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."role_permissions" DROP COLUMN "organization_id";
--> statement-breakpoint
ALTER TABLE "app"."role_permissions" ADD CONSTRAINT "role_permissions_tenant_role_permission_unique" UNIQUE("tenant_id", "role_key", "permission");
--> statement-breakpoint

ALTER TABLE "app"."authz_versions" DROP CONSTRAINT "authz_versions_tenant_org_unique";
--> statement-breakpoint
ALTER TABLE "app"."authz_versions" DROP CONSTRAINT "authz_versions_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."authz_versions" DROP COLUMN "organization_id";
--> statement-breakpoint
ALTER TABLE "app"."authz_versions" ADD CONSTRAINT "authz_versions_tenant_unique" UNIQUE("tenant_id");
--> statement-breakpoint

ALTER TABLE "app"."fx_rates" DROP CONSTRAINT "fx_rates_tenant_org_currency_date_unique";
--> statement-breakpoint
ALTER TABLE "app"."fx_rates" DROP CONSTRAINT "fx_rates_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."fx_rates" DROP COLUMN "organization_id";
--> statement-breakpoint
ALTER TABLE "app"."fx_rates" ADD CONSTRAINT "fx_rates_tenant_currency_date_unique" UNIQUE("tenant_id", "currency", "rate_date");
--> statement-breakpoint

-- users becomes tenant-scoped (section 3): the IdP org replaces organization_id, and the department moved to
-- user_entities. The idp_org_id FK is single-column here; 0014 makes it (tenant_id, idp_org_id).
DROP INDEX "app"."users_tenant_org_status_idx";
--> statement-breakpoint
DROP INDEX "app"."users_tenant_org_department_idx";
--> statement-breakpoint
ALTER TABLE "app"."users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."users" DROP CONSTRAINT "users_department_id_departments_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."users" DROP COLUMN "organization_id";
--> statement-breakpoint
ALTER TABLE "app"."users" DROP COLUMN "department_id";
--> statement-breakpoint
ALTER TABLE "app"."users" ALTER COLUMN "idp_org_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_idp_org_id_idp_orgs_id_fk" FOREIGN KEY ("idp_org_id") REFERENCES "app"."idp_orgs"("id");
--> statement-breakpoint
CREATE INDEX "users_tenant_status_idx" ON "app"."users" USING btree ("tenant_id", "status");
--> statement-breakpoint
CREATE INDEX "users_tenant_idp_org_idx" ON "app"."users" USING btree ("tenant_id", "idp_org_id");
--> statement-breakpoint

-- test_memos: the counterparty is a party (section 5). The column is renamed in place, so its values (the
-- customer org uuids, now the same-uuid parties) stay. An FK through a stored generated 'customer' checks the
-- kind and replaces the assert_org_kind trigger. NO ACTION: PostgreSQL refuses CASCADE and SET NULL on an FK
-- that contains a generated column. MATCH SIMPLE: not checked while customer_party_id is NULL.
DROP TRIGGER "test_memos_assert_customer_kind" ON "app"."test_memos";
--> statement-breakpoint
DROP FUNCTION "app"."assert_org_kind"();
--> statement-breakpoint
ALTER TABLE "app"."test_memos" DROP CONSTRAINT "test_memos_customer_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."test_memos" RENAME COLUMN "customer_organization_id" TO "customer_party_id";
--> statement-breakpoint
ALTER INDEX "app"."test_memos_tenant_customer_org_idx" RENAME TO "test_memos_tenant_customer_party_idx";
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD COLUMN "customer_party_kind" text GENERATED ALWAYS AS ('customer') STORED;
--> statement-breakpoint
ALTER TABLE "app"."test_memos" ADD CONSTRAINT "test_memos_customer_party_fk" FOREIGN KEY ("tenant_id", "customer_party_id", "customer_party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind");
--> statement-breakpoint

-- The customer and vendor rows leave organizations: they are parties now. Nothing references them any more: the
-- guards refused every other owner, the rows above moved or lost the column, and the memo FK targets parties.
-- The DELETE is audited under the row's own organization_id.
DELETE FROM "app"."organizations" WHERE "kind" <> 'staff';
--> statement-breakpoint
ALTER TABLE "app"."organizations" DROP CONSTRAINT "organizations_kind_check";
--> statement-breakpoint
ALTER TABLE "app"."organizations" DROP CONSTRAINT "organizations_zitadel_org_id_unique";
--> statement-breakpoint
ALTER TABLE "app"."organizations" DROP COLUMN "kind";
--> statement-breakpoint
ALTER TABLE "app"."organizations" DROP COLUMN "zitadel_org_id";
--> statement-breakpoint

-- Seed compatibility (section 11): the seed upserts its entity on (tenant_id, code = 'TR'). With that code on
-- the default entity, the upsert updates it instead of inserting a second default. Skipped in a tenant where
-- another entity already has the code.
UPDATE "app"."organizations" o
   SET "code" = 'TR', "legal_name" = 'Techrida Pvt. Ltd.'
 WHERE o."is_default"
   AND NOT EXISTS (
	SELECT 1 FROM "app"."organizations" t
	 WHERE t."tenant_id" = o."tenant_id" AND t."code" = 'TR' AND t."id" <> o."id");
