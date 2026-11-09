-- 0031_verification_party_kind: a verification (KYB) case can belong to a vendor as well as a customer (P4 K3).
--
-- 0015 tied the case to the customers table, so only a customer could have one. The case now names the kind of its
-- party and references the party itself:
--   * party_kind: 'customer' (the default, so every existing case stays a customer case) or 'vendor'.
--   * verification_cases_party_fk (tenant_id, party_id, party_kind) -> parties(tenant_id, id, kind) replaces
--     verification_cases_customer_fk. The kind is part of the key, so a case cannot name a customer party as a
--     vendor case or the other way round. The vendor row itself (the vendors table) comes with P4 S-V; until then
--     the party row is the only thing a vendor case can point at.
-- (tenant_id, party_id) stays unique: one case per party, whatever its kind. The table is already audited (0015).
-- The API refuses a kind that has no registered PartyOwnerPort, so no vendor case can be opened before V1 wires one.

ALTER TABLE "app"."verification_cases" ADD COLUMN "party_kind" text DEFAULT 'customer' NOT NULL;
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" DROP CONSTRAINT "verification_cases_customer_fk";
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD CONSTRAINT "verification_cases_party_kind_check" CHECK ("party_kind" in ('customer', 'vendor'));
--> statement-breakpoint
ALTER TABLE "app"."verification_cases" ADD CONSTRAINT "verification_cases_party_fk" FOREIGN KEY ("tenant_id", "party_id", "party_kind") REFERENCES "app"."parties"("tenant_id", "id", "kind");
