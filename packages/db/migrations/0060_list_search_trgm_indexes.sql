-- Trigram indexes for the list search of every module (ILIKE '%q%' and the fuzzy fallback), same shape as 0059.
-- Plain CREATE INDEX: the tables are small in dev. On a large production table, build the same index with
-- CREATE INDEX CONCURRENTLY outside the transaction runner instead.
CREATE INDEX leads_email_norm_trgm_idx ON app.leads USING gin (email_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_phone_e164_trgm_idx ON app.leads USING gin (phone_e164 gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_campaign_trgm_idx ON app.leads USING gin (campaign gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX opportunities_name_trgm_idx ON app.opportunities USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX opportunities_number_trgm_idx ON app.opportunities USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX activities_subject_trgm_idx ON app.activities USING gin (subject gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX activities_body_trgm_idx ON app.activities USING gin (body gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX customers_legal_name_trgm_idx ON app.customers USING gin (legal_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX customers_name_norm_trgm_idx ON app.customers USING gin (name_norm gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX customers_number_trgm_idx ON app.customers USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX customers_pan_vat_no_trgm_idx ON app.customers USING gin (pan_vat_no gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_legal_name_trgm_idx ON app.vendors USING gin (legal_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendors_pan_trgm_idx ON app.vendors USING gin (pan gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX parties_name_trgm_idx ON app.parties USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX parties_code_trgm_idx ON app.parties USING gin (code gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX quotations_number_trgm_idx ON app.quotations USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX sales_orders_number_trgm_idx ON app.sales_orders USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX invoices_number_trgm_idx ON app.invoices USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX payments_number_trgm_idx ON app.payments USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX payments_bank_reference_trgm_idx ON app.payments USING gin (bank_reference gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_requests_number_trgm_idx ON app.purchase_requests USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_requests_justification_trgm_idx ON app.purchase_requests USING gin (justification gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX rfqs_number_trgm_idx ON app.rfqs USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX purchase_orders_number_trgm_idx ON app.purchase_orders USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendor_bills_number_trgm_idx ON app.vendor_bills USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendor_bills_vendor_invoice_no_trgm_idx ON app.vendor_bills USING gin (vendor_invoice_no gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX payment_requests_number_trgm_idx ON app.payment_requests USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX vendor_bill_submissions_vendor_invoice_no_trgm_idx ON app.vendor_bill_submissions USING gin (vendor_invoice_no gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX approval_requests_title_trgm_idx ON app.approval_requests USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX approval_requests_document_number_trgm_idx ON app.approval_requests USING gin (document_number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX approval_steps_reason_trgm_idx ON app.approval_steps USING gin (reason gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX test_memos_number_trgm_idx ON app.test_memos USING gin (number gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX test_memos_title_trgm_idx ON app.test_memos USING gin (title gin_trgm_ops);
