-- Trigram indexes so list search (ILIKE '%q%' and the fuzzy fallback) does not scan the table.
CREATE INDEX leads_title_trgm_idx ON app.leads USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_company_name_trgm_idx ON app.leads USING gin (company_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_contact_name_trgm_idx ON app.leads USING gin (contact_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_number_trgm_idx ON app.leads USING gin (number gin_trgm_ops);
