-- 0011_approval_backstops: database backstops for approval decisions (P1 delta D10, unit N1).
--
-- RequestsService.act() already enforces all three rules below. These repeat them in the database, so a
-- service bug, a new code path or a hand-written INSERT cannot record a decision that breaks them:
--   * separation of duties: nobody in the request's sod_user_ids approves, returns or rejects it, neither
--     directly nor as a delegate's principal (approval_actions_guard);
--   * one decision per step (approval_actions_one_decision_per_step);
--   * a return or reject says why (approval_actions_comment_check).
--
-- Runs as bos_owner, after 0008, so the function is created without PUBLIC's EXECUTE anyway; the REVOKE
-- below says so explicitly.

-- Not SECURITY DEFINER: it only reads approval_requests, which bos_app may read already, so it runs with the
-- inserting role's rights. A parent request the inserting role cannot see (another tenant once RLS is on)
-- raises instead of skipping the check. Remind and escalate rows (NULL actor) never reach the lookup.
CREATE FUNCTION "app"."approval_actions_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
	v_sod uuid[];
BEGIN
	IF NEW."action" NOT IN ('approve', 'return', 'reject') THEN
		RETURN NEW;
	END IF;
	SELECT r."sod_user_ids" INTO v_sod FROM "app"."approval_requests" r WHERE r."id" = NEW."request_id";
	IF NOT FOUND THEN
		RAISE EXCEPTION 'approval request % not found for a % action', NEW."request_id", NEW."action"
			USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'approval_actions_request_id_fk';
	END IF;
	-- A NULL on_behalf_of_user_id gives NULL here, which IF treats as false.
	IF NEW."actor_user_id" = ANY (v_sod) OR NEW."on_behalf_of_user_id" = ANY (v_sod) THEN
		RAISE EXCEPTION 'separation of duties: user % may not % approval request % (listed in sod_user_ids)',
			CASE WHEN NEW."actor_user_id" = ANY (v_sod) THEN NEW."actor_user_id" ELSE NEW."on_behalf_of_user_id" END,
			NEW."action", NEW."request_id"
			USING ERRCODE = 'check_violation', CONSTRAINT = 'approval_actions_sod_check';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION "app"."approval_actions_guard"() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER "approval_actions_guard" BEFORE INSERT ON "app"."approval_actions"
FOR EACH ROW EXECUTE FUNCTION "app"."approval_actions_guard"();
--> statement-breakpoint

-- One decision per step. P1 has only "any" quorum (the first eligible approver decides the step), so a second
-- decision row on a step is always a double decision. When min-N quorum arrives, a step takes N approvals:
-- widen this then (e.g. one decision per (step, principal), with the quorum count checked by the service).
-- A return ends the request, and a resubmit creates a new request with new step rows, so no flow reuses a
-- decided step.
CREATE UNIQUE INDEX "approval_actions_one_decision_per_step" ON "app"."approval_actions" USING btree ("tenant_id", "step_id") WHERE "action" IN ('approve', 'return', 'reject');
--> statement-breakpoint

-- A return or reject carries a comment that is not blank. The characters stripped are ASCII whitespace only,
-- a subset of what the contract's zod .trim().min(1) strips, so the database never refuses a comment the API
-- accepted, and the check does not depend on the database locale. NOT VALID then VALIDATE (the P1 delta's
-- form): the dev database already has rows, and the separate VALIDATE names this constraint if one of them
-- fails. Both run in the migrator's transaction, so the lock gain of the split only applies to a later,
-- separate run of the same pattern.
ALTER TABLE "app"."approval_actions" ADD CONSTRAINT "approval_actions_comment_check" CHECK ("action" NOT IN ('return', 'reject') OR btrim(coalesce("comment", ''), E' \t\n\r\f\x0B') <> '') NOT VALID;
--> statement-breakpoint

ALTER TABLE "app"."approval_actions" VALIDATE CONSTRAINT "approval_actions_comment_check";
