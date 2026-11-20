-- 0126_user_locks_admin_default: every lock already stored as a timed lock becomes an admin lock (F1-Q4 review, P2-1).
--
-- Before the worker pinned the sign-in lockout policy, ZITADEL locked nobody for failed sign-ins (its default policy
-- has no attempt limits), so every LOCKED person was locked by an admin in the ZITADEL console. The first build of
-- the mirror recorded such a lock as `failed_sign_ins` with an end in the past, and the lock-expiry job then unlocked
-- the person. The mirror now records a lock it did not write as `admin` unless ZITADEL set it after the policy was
-- pinned; this converts the rows the first build already wrote. A lock that really came from failed sign-ins is kept
-- too, until an admin unlocks it: keeping someone out is the safe side.
--
-- Data: per tenant, every app.users row with lock_reason 'failed_sign_ins' gets lock_reason 'admin' and no end
-- (locked_until NULL; locked_at kept). Status, roles and the authz version do not change: the person stays out
-- exactly as before. Running it again changes nothing.
--
-- Not covered: a person the first build's expiry job already unlocked in ZITADEL is active again there and here;
-- this cannot lock them again. A LOCKED person the mirror has not stored yet needs nothing: the mirror stores them
-- as `admin` now.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0126. bos.organization_id is set per tenant in the loop (app.users is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0126', true),
	set_config('bos.correlation_id', 'migration-0126:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (
        SELECT 1 FROM app.users u
        WHERE u.tenant_id = org.tenant_id AND u.lock_reason = 'failed_sign_ins'
      )
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    UPDATE app.users u
    SET lock_reason = 'admin', locked_until = NULL, updated_at = now()
    WHERE u.tenant_id = target.tenant_id AND u.lock_reason = 'failed_sign_ins';
  END LOOP;
END;
$$;
