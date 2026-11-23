-- 0199_lead_address: a lead may carry an optional address (D9, Kuu 2026-11-23): the street lines and city, with the
-- lead's own country (leads.country, 0191) as the address's country. Both columns are set together or not at all,
-- as vendors' are (vendors_address_check). Existing leads keep NULL: none had an address. No data is written.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "address_line" text;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "address_city" text;
--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_address_check" CHECK ((("address_line" IS NULL) = ("address_city" IS NULL)) AND btrim("address_line") <> '' AND btrim("address_city") <> '');
