-- Carry the requester's goods serial requirement through sourcing to the issued PO.
-- Existing requests remain unchanged; the existing line-freeze trigger protects this column too.
ALTER TABLE "app"."purchase_request_lines"
  ADD COLUMN "requires_serials" boolean DEFAULT false NOT NULL;
