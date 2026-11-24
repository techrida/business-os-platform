-- 0222_vendor_quotation_line_description (R6Q23, Kuu 2026-11-25): a vendor quotation line carries its own description.
--
-- A line was only identified through its request line, so the quotation could not be read on its own and a later
-- change of the request wording changed what an old quotation appeared to quote. The description is now stored with
-- the line: recording a quotation defaults it to the request line's description.
--
-- Data written (audited as system:migration-0222): every existing vendor_quotation_lines row takes the description of
-- its request line (purchase_request_lines.description, same tenant, entity and request; a request line whose text is blank, which the API never allowed, becomes 'Item' so the CHECK below cannot fail). Then the column is NOT NULL
-- with a non-blank CHECK. The data statement is idempotent: a row that has a
-- description is not touched. Runs as bos_owner in the migrator's one transaction, split at the breakpoint comments.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0222', true),
	set_config('bos.correlation_id', 'migration-0222:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."vendor_quotation_lines" ADD COLUMN "description" text;
--> statement-breakpoint
UPDATE "app"."vendor_quotation_lines" AS l
SET "description" = COALESCE(NULLIF(btrim(p."description"), ''), 'Item')
FROM "app"."purchase_request_lines" AS p
WHERE l."description" IS NULL
	AND p."tenant_id" = l."tenant_id"
	AND p."organization_id" = l."organization_id"
	AND p."purchase_request_id" = l."purchase_request_id"
	AND p."id" = l."pr_line_id";
--> statement-breakpoint
ALTER TABLE "app"."vendor_quotation_lines" ALTER COLUMN "description" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."vendor_quotation_lines" ADD CONSTRAINT "vendor_quotation_lines_description_check" CHECK (btrim("description") <> '');
