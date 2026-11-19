-- 0069_default_term_sets_for_existing_tenants: companies that already saved their term sets get the app's four default sets (D43).
--
-- `quotation.term_presets` holds one list per entity. A company that never saved it sees the defaults through the
-- code default; a company that did save it sees only its own list, so the four default sets (D31) never appeared
-- for it. Append the defaults that are missing and keep everything else:
--   * a default is skipped when the saved list already holds its id, or a set of the same kind with the same
--     name (ignoring case): the company's own set is never replaced or edited;
--   * the list stays within its 200-set limit (a default that would pass it is skipped);
--   * append-only: a new version is written (latest + 1); the old rows stay as history; a company that already
--     has every default gets no row, so running this twice changes nothing;
--   * entities with no saved list need nothing (the code default applies).
-- The four sets below are DEFAULT_TERM_PRESETS (packages/contracts/src/document-style.ts) as of this migration.

SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0069', true),
	set_config('bos.correlation_id', 'migration-0069:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

WITH defaults AS (
	SELECT d.value AS preset, d.ordinality AS position
	  FROM jsonb_array_elements('[{"id":"6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0001","kind":"terms_conditions","name":"Casual website terms","body":"<p><strong>Website project terms</strong></p><ul><li>Fifty percent is due before work starts and the balance on launch.</li><li>The price covers the pages and features listed in the scope. Extra work is quoted separately.</li><li>We need your content, logo and feedback within the times we agree. Delays on your side can move the launch date.</li><li>Two rounds of changes are included. Further rounds are charged by the hour.</li><li>You own the finished site once the invoice is paid in full.</li></ul>"},{"id":"6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0002","kind":"terms_conditions","name":"Software project terms","body":"<p><strong>Software project terms</strong></p><ol><li>Work follows the milestones in the payment schedule. A milestone is payable when it is delivered for review.</li><li>Anything outside the scope and assumptions is a change request. We quote it and start it only after you approve.</li><li>You review each delivery within <strong>seven days</strong>. Silence after that counts as acceptance.</li><li>Confidential material shared by either side stays confidential.</li><li>Either side may end the work with written notice. You pay for work done up to that date.</li></ol>"},{"id":"6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0003","kind":"terms_conditions","name":"Support and maintenance terms","body":"<p><strong>Support and maintenance terms</strong></p><ul><li>The fee is charged <em>in advance</em> for each period and is not refunded for unused time.</li><li>Support covers fixes and questions about what we delivered. New features are quoted separately.</li><li>We reply within one working day. Urgent faults that stop your business are looked at first.</li><li>Either side can end the arrangement with thirty days of written notice.</li></ul>"},{"id":"6c1e8a40-5b0b-4f0e-9a52-0c8d1a7e0004","kind":"payment_terms","name":"Half up front","body":"<ul><li><strong>50%</strong> when you accept this quotation.</li><li><strong>50%</strong> when the work is delivered.</li></ul><p>Invoices are payable within the term shown above.</p>"}]'::jsonb) WITH ORDINALITY AS d(value, ordinality)
),
latest AS (
	SELECT DISTINCT ON (s."tenant_id", s."organization_id")
		s."tenant_id", s."organization_id", s."version", s."value"
	  FROM "app"."settings" s
	 WHERE s."key" = 'quotation.term_presets'
	   AND jsonb_typeof(s."value") = 'array'
	 ORDER BY s."tenant_id", s."organization_id", s."version" DESC
),
missing AS (
	SELECT l."tenant_id", l."organization_id", l."version", l."value",
	       d.preset, d.position,
	       jsonb_array_length(l."value") AS saved_count
	  FROM latest l
	  CROSS JOIN defaults d
	 WHERE NOT EXISTS (
		SELECT 1 FROM jsonb_array_elements(l."value") e
		 WHERE e ->> 'id' = d.preset ->> 'id'
		    OR (e ->> 'kind' = d.preset ->> 'kind' AND lower(e ->> 'name') = lower(d.preset ->> 'name')))
),
numbered AS (
	SELECT m.*, row_number() OVER (PARTITION BY m."tenant_id", m."organization_id" ORDER BY m.position) AS n
	  FROM missing m
),
appended AS (
	SELECT n."tenant_id", n."organization_id", n."version",
	       n."value" || jsonb_agg(n.preset ORDER BY n.position) AS merged
	  FROM numbered n
	 WHERE n.saved_count + n.n <= 200
	 GROUP BY n."tenant_id", n."organization_id", n."version", n."value"
)
INSERT INTO "app"."settings" ("tenant_id", "organization_id", "key", "version", "value")
SELECT a."tenant_id", a."organization_id", 'quotation.term_presets', a."version" + 1, a.merged
  FROM appended a;
