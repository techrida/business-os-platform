-- 0054_party_logos: a customer's or vendor's logo is a stored document (U12, images as documents).
--
--   * Nullable uuid, no default: a party without an uploaded logo shows the initials avatar, as before.
--   * No foreign key, for the same reason as 0053: documents are owned per tenant and entity, and the logo is
--     checked against the party's tenant by the documents service when it is set. A read of a missing document
--     falls back to the initials.
--   * Adding a nullable column with no default rewrites nothing; the audit triggers are unchanged.

ALTER TABLE "app"."customers" ADD COLUMN "logo_document_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."vendors" ADD COLUMN "logo_document_id" uuid;
