-- 0018_quotation_acceptance_evidence: an acceptance keeps who signed and which files prove it (P2 follow-up FU1).
--
-- Unit Q3b first kept the signer's name and the evidence document ids only in the audit event, because the table
-- had no column for them. Both now live on the acceptance row, so the DTO and the portal read them from the
-- record itself:
--   * accepted_by_name: the name the customer signed with. NULL when none was given (a rejection, or a staff
--     entry that did not record one). At most 200 characters, like the contracts' schema.
--   * evidence_document_ids: kernel document ids of the uploaded evidence files, in the order given. No foreign
--     key: Postgres cannot reference the elements of an array, and the service only writes ids it was handed
--     from DocumentsService. NULL elements are refused.
-- Both are new columns on existing rows, so the append-only trigger (BEFORE UPDATE OR DELETE, 0016) is not
-- involved: existing rows keep the defaults without being updated, and new rows are inserted once and then frozen
-- by the same trigger as before. This migration neither drops nor changes that trigger.

ALTER TABLE "app"."quotation_acceptances" ADD COLUMN "accepted_by_name" text;
--> statement-breakpoint

ALTER TABLE "app"."quotation_acceptances" ADD COLUMN "evidence_document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint

ALTER TABLE "app"."quotation_acceptances" ADD CONSTRAINT "quotation_acceptances_accepted_by_name_check" CHECK ("accepted_by_name" IS NULL OR char_length("accepted_by_name") <= 200);
--> statement-breakpoint

ALTER TABLE "app"."quotation_acceptances" ADD CONSTRAINT "quotation_acceptances_evidence_document_ids_check" CHECK (array_position("evidence_document_ids", NULL) IS NULL);
