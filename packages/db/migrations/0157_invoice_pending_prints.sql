-- 0157_invoice_pending_prints: a stored invoice PDF keeps the print it is until its print row is written (round 5, S3).
--
-- The invoice render sweeper stores the PDF first and writes its `invoice_print_log` row afterwards, so a crash never
-- logs a print nobody received. When that write failed twice the PDF stayed live with no print row: print 1's frozen
-- format (number grouping, date pattern, logo, seller contact) was lost, the portal drew the invoice with the
-- settings in force, and a later print would have numbered itself print 1 again.
--
-- * invoice_pending_prints: one row per stored invoice PDF whose print row is not written yet. The sweeper inserts it
--   in the same transaction as the generated document (createGenerated), and deletes it in the transaction that
--   writes the print row. A row whose document is live and holds a clean PDF is therefore a print row that is owed:
--   each sweep writes it from here (print number and frozen format) and deletes the row.
-- * A row of a document that never got its bytes stays behind harmlessly when the document is removed (the sweep only
--   reads rows of live documents with a clean upload).
-- DDL only: no rows are written, so no audit actor is needed.

CREATE TABLE "app"."invoice_pending_prints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"print_no" integer NOT NULL,
	"render_format" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_pending_prints_tenant_id_unique" UNIQUE("tenant_id", "id"),
	CONSTRAINT "invoice_pending_prints_document_unique" UNIQUE("tenant_id", "organization_id", "document_id"),
	CONSTRAINT "invoice_pending_prints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "app"."tenants"("id"),
	CONSTRAINT "invoice_pending_prints_tenant_org_fk" FOREIGN KEY ("tenant_id", "organization_id") REFERENCES "app"."organizations"("tenant_id", "id"),
	CONSTRAINT "invoice_pending_prints_invoice_fk" FOREIGN KEY ("tenant_id", "organization_id", "invoice_id") REFERENCES "app"."invoices"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoice_pending_prints_document_fk" FOREIGN KEY ("tenant_id", "organization_id", "document_id") REFERENCES "app"."documents"("tenant_id", "organization_id", "id"),
	CONSTRAINT "invoice_pending_prints_print_no_check" CHECK ("print_no" >= 1)
);
--> statement-breakpoint

SELECT audit.attach('app.invoice_pending_prints');
