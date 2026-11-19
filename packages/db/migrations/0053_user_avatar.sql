-- 0053_user_avatar: a person's avatar is a stored document (U12, images as documents).
--
--   * Nullable uuid, no default: a user without an uploaded image shows the initials avatar, as before.
--   * No foreign key: documents are owned by a tenant and an entity, while a user is tenant-scoped and works in
--     several entities, so no single (tenant_id, organization_id, id) key fits. The documents service checks
--     the id belongs to the tenant when it is set, and a read of a missing document falls back to the initials.
--   * Adding a nullable column with no default rewrites nothing; the users audit trigger is unchanged.

ALTER TABLE "app"."users" ADD COLUMN "avatar_document_id" uuid;
