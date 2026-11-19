-- B-tree indexes for list filters and the default list order (newest first, id as tie-break).
-- Plain CREATE INDEX: the tables are small in dev. On a large production table, build the same index with
-- CREATE INDEX CONCURRENTLY outside the transaction runner instead.
CREATE INDEX leads_tenant_org_owner_idx ON app.leads (tenant_id, organization_id, owner_user_id);
--> statement-breakpoint
CREATE INDEX opportunities_tenant_org_created_idx ON app.opportunities (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX activities_tenant_org_occurred_idx ON app.activities (tenant_id, organization_id, occurred_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX sales_orders_tenant_org_created_idx ON app.sales_orders (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX invoices_tenant_org_created_idx ON app.invoices (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX payments_tenant_org_created_idx ON app.payments (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX purchase_requests_tenant_org_created_idx ON app.purchase_requests (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX rfqs_tenant_org_created_idx ON app.rfqs (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX purchase_orders_tenant_org_created_idx ON app.purchase_orders (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX vendor_bills_tenant_org_created_idx ON app.vendor_bills (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX payment_requests_tenant_org_created_idx ON app.payment_requests (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX quotations_tenant_org_created_idx ON app.quotations (tenant_id, organization_id, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX approval_requests_tenant_org_status_submitted_idx ON app.approval_requests (tenant_id, organization_id, status, submitted_at, id);
--> statement-breakpoint
CREATE INDEX customers_tenant_relationship_idx ON app.customers (tenant_id, relationship);
--> statement-breakpoint
CREATE INDEX customers_tenant_industry_idx ON app.customers (tenant_id, industry);
--> statement-breakpoint
CREATE INDEX vendors_tenant_kind_idx ON app.vendors (tenant_id, kind);
--> statement-breakpoint
CREATE INDEX verification_cases_tenant_status_created_idx ON app.verification_cases (tenant_id, status, created_at DESC, id DESC);
