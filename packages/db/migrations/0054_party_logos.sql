-- 0054_party_logos: a customer's or vendor's logo is a stored document (U12, images as documents).
--
--   * Nullable uuid, no default: a party without an uploaded logo shows the initials avatar, as before.
--   * No foreign key, for the same reason as 0053: documents are owned per tenant and entity. Whatever sets the
--     column must check the document belongs to the party's tenant; a reader treats a missing document like NULL.
--   * Adding a nullable column with no default rewrites nothing; the audit triggers are unchanged.

ALTER TABLE "app"."customers" ADD COLUMN "logo_document_id" uuid;
--> statement-breakpoint
ALTER TABLE "app"."vendors" ADD COLUMN "logo_document_id" uuid;
