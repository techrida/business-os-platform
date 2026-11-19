-- init-dbs.sh revokes every right on schema public, and pg_trgm lives there (0041), so the app role could not
-- call word_similarity or the <% operator the fuzzy list search needs. Public holds only the extension's objects.
GRANT USAGE ON SCHEMA public TO bos_app;
--> statement-breakpoint
-- Trigram indexes so list search (ILIKE '%q%' and the fuzzy fallback) does not scan the table.
CREATE INDEX leads_title_trgm_idx ON app.leads USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_company_name_trgm_idx ON app.leads USING gin (company_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_contact_name_trgm_idx ON app.leads USING gin (contact_name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX leads_number_trgm_idx ON app.leads USING gin (number gin_trgm_ops);
