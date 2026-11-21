-- 0153_payment_promise_replaced: a promise to pay can be replaced (decision R4c1 Q6). Recording a new promise on an
-- invoice that already has an open one closes the open one as `replaced` in the same transaction, instead of refusing
-- the new one. A replaced promise is history, like a missed or kept one: the hourly payment-promise job only reads
-- open promises, and payment_promises_missed_check still holds (missed_at and collection_activity_id stay null).
-- The new allow-list is a superset of 0113's, so every existing row stays valid. Schema only: no data changes.
--
-- Runs as bos_owner, split at the breakpoint comments.

ALTER TABLE "app"."payment_promises" DROP CONSTRAINT "payment_promises_status_check";
--> statement-breakpoint
ALTER TABLE "app"."payment_promises" ADD CONSTRAINT "payment_promises_status_check" CHECK ("status" in ('open', 'missed', 'kept', 'replaced'));
