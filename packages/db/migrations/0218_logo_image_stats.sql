-- 0218_logo_image_stats: what the company logo images measure (R6AC). A company may upload a primary logo and optional
-- logos for dark and for light backgrounds (owner types entity_logo, entity_logo_on_dark, entity_logo_on_light). A
-- document picks the one that stays readable on its header colour (WCAG 1.4.11, 3:1), from two numbers per image: its
-- alpha-weighted mean relative luminance and whether it has transparent pixels. Both are measured from the bytes when
-- the image is uploaded and kept here, one row per image document, so a render does not decode every logo again.
-- The row is a cache: a render that finds none measures the bytes itself. Nothing existing is changed or backfilled.
--
-- Tenant scoping follows `document_versions`: tenant_id and organization_id on the row, a composite foreign key to the
-- document that carries both, and a composite foreign key to the organization. The database has no row-level
-- security policies; the API filters by tenant, and the composite keys make a row of another tenant unreferenceable.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "app"."logo_image_stats" (
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"luminance" real NOT NULL,
	"has_transparency" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "logo_image_stats_pk" PRIMARY KEY ("tenant_id", "organization_id", "document_id"),
	CONSTRAINT "logo_image_stats_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "logo_image_stats_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "logo_image_stats_variant_check" CHECK ("variant" IN ('primary', 'on_dark', 'on_light')),
	CONSTRAINT "logo_image_stats_luminance_check" CHECK ("luminance" >= 0 AND "luminance" <= 1)
);
