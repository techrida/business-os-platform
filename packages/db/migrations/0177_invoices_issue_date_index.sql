-- 0177_invoices_issue_date_index: the sales VAT register (round 5, K1) reads the issued documents of one legal entity
-- between two issue dates. A partial index on issued rows keeps that read off the whole invoices table: it holds only
-- issued documents, in issue-date order within a tenant and entity. DDL only: no rows are written, so no audit actor
-- is needed.

CREATE INDEX "invoices_issued_date_idx" ON "app"."invoices" USING btree ("tenant_id","organization_id","issue_date") WHERE "app"."invoices"."status" = 'issued';
