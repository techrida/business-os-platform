-- 0017_approvals_cancel: a module may cancel an open approval request (P2 unit K1, kernel gap M5).
--
-- ApprovalsService.cancel() sets the request to 'cancelled' (already allowed by approval_requests_status_check
-- and approval_requests_decided_check since 0006), skips its open steps and logs a 'cancel' action. Two
-- approval_actions checks change:
--   * approval_actions_action_check accepts the new action 'cancel';
--   * approval_actions_actor_check lets a cancel row have no actor user, because a system job (a quotation
--     that expires while pending) cancels too, as remind and escalate already do.
-- A cancel is not a decision: the separation-of-duties guard, the one-decision-per-step index and the
-- comment check of 0011 do not list it, so a requester's module may cancel its own request.
-- NOT VALID then VALIDATE, the pattern of 0011: existing rows are re-checked by the separate VALIDATE.

ALTER TABLE "app"."approval_actions" DROP CONSTRAINT "approval_actions_action_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_action_check" CHECK ("action" in ('submit', 'approve', 'return', 'reject', 'escalate', 'remind', 'block', 'reroute', 'cancel')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" VALIDATE CONSTRAINT "approval_actions_action_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" DROP CONSTRAINT "approval_actions_actor_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_actor_check" CHECK ("actor_user_id" IS NOT NULL OR "action" in ('remind', 'escalate', 'cancel')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" VALIDATE CONSTRAINT "approval_actions_actor_check";
