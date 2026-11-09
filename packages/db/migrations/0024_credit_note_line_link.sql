-- 0024_credit_note_line_link: which original line a credit-note line credits (P3 plan unit U12 part D).
--
-- Until now only a credit note's total was capped across notes, so two notes could each credit line 1 of a two-line
-- invoice in full while the total stayed under the cap, and "credited in full" was a total test. The service now caps
-- credits per original line and per tax code; for that each credit-note line names the original line it credits:
--   * invoice_lines.original_line_id, uuid, NULL for tax invoice, proforma and debit note lines. A credit-note line
--     drafted from 0024 on always sets it (NoteDraftingService). Credit-note lines drafted before 0024 stay NULL: their
--     original line cannot be recovered reliably, so they count only toward the total cap.
--   * a composite FK to the original line in the same entity, which needs UNIQUE (tenant_id, organization_id, id) on
--     invoice_lines, and an index for the per-line sums.
-- audit stays attached to invoice_lines (0021): audit.capture_row reads the whole row, so the new column is in the
-- hash chain with no further change. Runs as bos_owner, split at the breakpoints. Names follow the K1-U2 convention,
-- mirrored in src/schema/invoicing.ts.

ALTER TABLE "app"."invoice_lines" ADD COLUMN "original_line_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_org_id_unique" UNIQUE("tenant_id", "organization_id", "id");
--> statement-breakpoint
ALTER TABLE "app"."invoice_lines" ADD CONSTRAINT "invoice_lines_original_line_fk" FOREIGN KEY ("tenant_id", "organization_id", "original_line_id") REFERENCES "app"."invoice_lines"("tenant_id", "organization_id", "id");
--> statement-breakpoint
CREATE INDEX "invoice_lines_tenant_original_line_idx" ON "app"."invoice_lines" USING btree ("tenant_id", "original_line_id");
