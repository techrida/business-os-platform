-- 0001_audit: the tamper-evident audit trail (k-audit). Serves the NFR "every change is audited, and the
-- trail is tamper-evident" (ADR 0020).
--
-- How it fits together:
--   * audit.audit_events holds one row per change. bos_app has NO table privilege on it: it can only append
--     through the SECURITY DEFINER functions below (stricter than INSERT-only, because an INSERT right would
--     let the app write a row with a made-up hash).
--   * Rows form one SHA-256 hash chain per (tenant, UTC month). Each row's hash covers the previous row's
--     hash, so changing or deleting any row breaks every hash after it. Months link to each other through
--     the last hash of the previous month; the first row of a tenant links to '\x00'.
--   * audit.attach('app.<table>') puts the row trigger audit_capture on a business table. The trigger RAISEs
--     when bos.actor_id is unset, so a write that bypasses withTx() fails instead of going unaudited.
--   * audit.verify_chain() recomputes the hashes with the same SQL function that wrote them
--     (audit.event_hash), so writer and checker can never drift apart.
--
-- Runs as bos_owner, so bos_owner owns every object here (SECURITY DEFINER functions run as bos_owner).
-- Drizzle splits the file at the breakpoint comments and runs it in one transaction.

CREATE SCHEMA "audit";
--> statement-breakpoint

CREATE TABLE "audit"."audit_events" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	-- First day of the UTC month whose chain this row belongs to.
	"chain_month" date NOT NULL,
	-- Position in the (tenant, month) chain: 1, 2, 3, ... with no gaps (taken under the advisory lock).
	"seq" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- NOT NULL (the plan leaves it nullable): withTx always sets it, and the API contract has no null kind.
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"meta" jsonb,
	"ip" inet,
	"user_agent" text,
	"correlation_id" text NOT NULL,
	"prev_hash" bytea NOT NULL,
	"hash" bytea NOT NULL,
	CONSTRAINT "audit_events_chain_unique" UNIQUE ("tenant_id", "chain_month", "seq"),
	CONSTRAINT "audit_events_actor_kind_check" CHECK ("actor_kind" in ('user', 'system', 'zitadel', 'seed'))
);
--> statement-breakpoint

-- The read path (GET /v1/audit?entityId=) filters by scope and entity and pages by id.
CREATE INDEX "audit_events_entity_idx" ON "audit"."audit_events" USING btree ("tenant_id", "organization_id", "entity_type", "entity_id", "id");
--> statement-breakpoint

-- One row per closed month, written by the monthly seal job: the chain's tail at the time it was sealed.
CREATE TABLE "audit"."chain_seals" (
	"tenant_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"chain_month" date NOT NULL,
	"last_seq" bigint NOT NULL,
	"last_hash" bytea NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_seals_pkey" PRIMARY KEY ("tenant_id", "chain_month")
);
--> statement-breakpoint

-- The one canonical hash expression. append() writes with it and verify_chain() recomputes with it.
-- Every field goes through coalesce: concat_ws silently skips NULLs, which would let two different rows
-- hash the same text. chain_month is formatted with to_char instead of ::text, because date output follows
-- the session's DateStyle and the hash must not depend on a client setting.
CREATE FUNCTION "audit"."event_hash"(
	p_prev_hash bytea, p_id bigint, p_tenant_id uuid, p_chain_month date, p_seq bigint,
	p_occurred_at timestamptz, p_actor_kind text, p_actor_id text, p_action text, p_entity_type text,
	p_entity_id text, p_before jsonb, p_after jsonb, p_meta jsonb, p_ip inet, p_user_agent text,
	p_correlation_id text
) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, audit, app
AS $$
	SELECT sha256(p_prev_hash || convert_to(concat_ws(E'\x1f',
		coalesce(p_id::text, ''),
		coalesce(p_tenant_id::text, ''),
		coalesce(to_char(p_chain_month, 'YYYY-MM-DD'), ''),
		coalesce(p_seq::text, ''),
		coalesce(to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), ''),
		coalesce(p_actor_kind, ''),
		coalesce(p_actor_id, ''),
		coalesce(p_action, ''),
		coalesce(p_entity_type, ''),
		coalesce(p_entity_id, ''),
		coalesce(p_before::text, ''),
		coalesce(p_after::text, ''),
		coalesce(p_meta::text, ''),
		coalesce(host(p_ip), ''),
		coalesce(p_user_agent, ''),
		coalesce(p_correlation_id, '')
	), 'UTF8'))
$$;
--> statement-breakpoint

-- Internal: appends one event to its tenant's chain. Actor, correlation id, ip and user agent come from the
-- bos.* settings that withTx() sets with set_config(..., true).
--
-- Must stay VOLATILE (the default): a volatile function takes a fresh snapshot per statement, so the "last
-- row" read after the lock sees what the previous lock holder committed. p_occurred_at exists for tests
-- that need a row in another month; only bos_owner can call append, so the app cannot backdate events.
CREATE FUNCTION "audit"."append"(
	p_tenant_id uuid, p_organization_id uuid, p_action text, p_entity_type text, p_entity_id text,
	p_before jsonb, p_after jsonb, p_meta jsonb, p_occurred_at timestamptz DEFAULT now()
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
DECLARE
	-- An unset setting reads as NULL, or as '' once set_config has touched it on this pooled connection.
	v_actor_id text := nullif(current_setting('bos.actor_id', true), '');
	v_actor_kind text := nullif(current_setting('bos.actor_kind', true), '');
	v_correlation_id text := coalesce(nullif(current_setting('bos.correlation_id', true), ''), '');
	v_ip inet := nullif(current_setting('bos.ip', true), '')::inet;
	v_user_agent text := nullif(current_setting('bos.user_agent', true), '');
	v_month date := date_trunc('month', p_occurred_at AT TIME ZONE 'UTC')::date;
	v_seq bigint;
	v_prev bytea;
	v_id bigint;
BEGIN
	IF v_actor_id IS NULL THEN
		RAISE EXCEPTION 'audit: bos.actor_id is not set; every write must go through withTx()';
	END IF;
	IF v_actor_kind IS NULL THEN
		RAISE EXCEPTION 'audit: bos.actor_kind is not set; every write must go through withTx()';
	END IF;
	IF p_tenant_id IS NULL OR p_organization_id IS NULL THEN
		RAISE EXCEPTION 'audit: % has no tenant_id or organization_id', p_entity_type;
	END IF;

	-- One writer per (tenant, month) at a time, held until COMMIT, so seq is gap-free and the chain is a line.
	PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text || to_char(v_month, 'YYYY-MM-DD'), 0));

	SELECT e.seq, e.hash INTO v_seq, v_prev
	  FROM audit.audit_events e
	 WHERE e.tenant_id = p_tenant_id AND e.chain_month = v_month
	 ORDER BY e.seq DESC
	 LIMIT 1;

	IF NOT FOUND THEN
		-- First row of the month: wait for any in-flight writer of the previous month to commit, then link to
		-- the last hash of the most recent earlier month. Locks are taken newer month first only here, and an
		-- older month's writer never asks for a newer month's lock, so this cannot deadlock.
		PERFORM pg_advisory_xact_lock(hashtextextended(
			p_tenant_id::text || to_char((v_month - interval '1 month')::date, 'YYYY-MM-DD'), 0));
		v_seq := 0;
		SELECT e.hash INTO v_prev
		  FROM audit.audit_events e
		 WHERE e.tenant_id = p_tenant_id AND e.chain_month < v_month
		 ORDER BY e.chain_month DESC, e.seq DESC
		 LIMIT 1;
		IF NOT FOUND THEN
			v_prev := '\x00'::bytea;
		END IF;
	END IF;

	-- The id is part of the hash, so it is taken from the identity sequence before hashing and inserted with
	-- OVERRIDING SYSTEM VALUE. (Insert-then-update would need UPDATE on an append-only table.)
	v_id := nextval(pg_get_serial_sequence('audit.audit_events', 'id'));
	v_seq := v_seq + 1;

	INSERT INTO audit.audit_events (
		id, tenant_id, organization_id, chain_month, seq, occurred_at, actor_kind, actor_id, action,
		entity_type, entity_id, before, after, meta, ip, user_agent, correlation_id, prev_hash, hash
	) OVERRIDING SYSTEM VALUE VALUES (
		v_id, p_tenant_id, p_organization_id, v_month, v_seq, p_occurred_at, v_actor_kind, v_actor_id, p_action,
		p_entity_type, p_entity_id, p_before, p_after, p_meta, v_ip, v_user_agent, v_correlation_id, v_prev,
		audit.event_hash(v_prev, v_id, p_tenant_id, v_month, v_seq, p_occurred_at, v_actor_kind, v_actor_id,
			p_action, p_entity_type, p_entity_id, p_before, p_after, p_meta, v_ip, v_user_agent, v_correlation_id)
	);
	RETURN v_id;
END;
$$;
--> statement-breakpoint

-- The row trigger that audit.attach() installs as audit_capture (AFTER INSERT/UPDATE/DELETE, FOR EACH ROW).
-- TG_ARGV[0] = redacted columns (removed from before and after), TG_ARGV[1] = ignored columns (an UPDATE
-- that changes only these writes no event). Both arrive as array literals such as '{secret}'.
-- SECURITY DEFINER: it fires for bos_app, which has no right on audit_events, and appends as bos_owner.
CREATE FUNCTION "audit"."capture_row"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
DECLARE
	v_redact text[] := CASE WHEN TG_NARGS > 0 THEN TG_ARGV[0]::text[] ELSE '{}'::text[] END;
	v_ignore text[] := CASE WHEN TG_NARGS > 1 THEN TG_ARGV[1]::text[] ELSE '{}'::text[] END;
	v_old jsonb;
	v_new jsonb;
	v_row jsonb;
	v_entity_id text;
BEGIN
	IF nullif(current_setting('bos.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'audit: bos.actor_id is not set; write to %.% through withTx()', TG_TABLE_SCHEMA, TG_TABLE_NAME;
	END IF;

	IF TG_OP IN ('UPDATE', 'DELETE') THEN v_old := to_jsonb(OLD); END IF;
	IF TG_OP IN ('INSERT', 'UPDATE') THEN v_new := to_jsonb(NEW); END IF;

	-- Nothing but ignored columns changed (e.g. a counter): no event.
	IF TG_OP = 'UPDATE' AND (v_old - v_ignore) = (v_new - v_ignore) THEN
		RETURN NULL;
	END IF;

	v_row := coalesce(v_new, v_old);
	v_entity_id := v_row ->> 'id';
	IF v_entity_id IS NULL THEN
		-- No id column (e.g. a composite primary key): name the row by its primary-key values joined with '/'.
		SELECT string_agg(v_row ->> a.attname, '/' ORDER BY k.ord) INTO v_entity_id
		  FROM pg_index i
		 CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
		  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
		 WHERE i.indrelid = TG_RELID AND i.indisprimary;
	END IF;

	PERFORM audit.append(
		(v_row ->> 'tenant_id')::uuid,
		(v_row ->> 'organization_id')::uuid,
		TG_TABLE_NAME || '.' || lower(TG_OP),
		TG_TABLE_NAME,
		coalesce(v_entity_id, ''),
		v_old - v_redact,
		v_new - v_redact,
		NULL
	);
	RETURN NULL;
END;
$$;
--> statement-breakpoint

-- Installs (or re-installs, e.g. with a new redact list) the audit_capture trigger on a table.
-- Every new app.* table ends its migration with SELECT audit.attach('app.<table>'); check-audit verifies it.
CREATE FUNCTION "audit"."attach"(tbl regclass, redact text[] DEFAULT '{}', ignore text[] DEFAULT '{}')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
DECLARE
	v_schema text;
	v_table text;
	v_missing text;
BEGIN
	SELECT n.nspname, c.relname INTO v_schema, v_table
	  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
	 WHERE c.oid = tbl;

	-- A typo in a redact list would silently leak the column into the trail, so unknown names fail here.
	SELECT string_agg(col, ', ') INTO v_missing
	  FROM unnest(ARRAY['tenant_id', 'organization_id'] || coalesce(redact, '{}') || coalesce(ignore, '{}')) AS col
	 WHERE NOT EXISTS (
		SELECT 1 FROM pg_attribute a
		 WHERE a.attrelid = tbl AND a.attname = col AND a.attnum > 0 AND NOT a.attisdropped);
	IF v_missing IS NOT NULL THEN
		RAISE EXCEPTION 'audit.attach(%): no such column(s): %', tbl, v_missing;
	END IF;

	EXECUTE format('DROP TRIGGER IF EXISTS audit_capture ON %I.%I', v_schema, v_table);
	EXECUTE format(
		'CREATE TRIGGER audit_capture AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
		'FOR EACH ROW EXECUTE FUNCTION audit.capture_row(%L, %L)',
		v_schema, v_table, coalesce(redact, '{}')::text, coalesce(ignore, '{}')::text);
END;
$$;
--> statement-breakpoint

-- Domain events that are not a row change (e.g. approval.approved). Tenant, org and actor come from the
-- bos.* settings of the current withTx() transaction. Returns the new event id.
CREATE FUNCTION "audit"."record"(
	p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_meta jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
DECLARE
	v_tenant_id uuid := nullif(current_setting('bos.tenant_id', true), '')::uuid;
	v_organization_id uuid := nullif(current_setting('bos.organization_id', true), '')::uuid;
BEGIN
	IF v_tenant_id IS NULL OR v_organization_id IS NULL THEN
		RAISE EXCEPTION 'audit: bos.tenant_id / bos.organization_id are not set; call record() inside withTx()';
	END IF;
	RETURN audit.append(v_tenant_id, v_organization_id, p_action, p_entity_type, p_entity_id,
		p_before, p_after, p_meta, now());
END;
$$;
--> statement-breakpoint

-- The API's read path. NULL filters mean "any". Pages forward by id (after_id is the last id seen).
CREATE FUNCTION "audit"."read_events"(
	p_tenant_id uuid, p_organization_id uuid, p_entity_type text, p_entity_id text,
	p_from timestamptz, p_to timestamptz, p_after_id bigint, p_lim integer
) RETURNS SETOF "audit"."audit_events"
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
	SELECT e.*
	  FROM audit.audit_events e
	 WHERE e.tenant_id = p_tenant_id
	   AND (p_organization_id IS NULL OR e.organization_id = p_organization_id)
	   AND (p_entity_type IS NULL OR e.entity_type = p_entity_type)
	   AND (p_entity_id IS NULL OR e.entity_id = p_entity_id)
	   AND (p_from IS NULL OR e.occurred_at >= p_from)
	   AND (p_to IS NULL OR e.occurred_at < p_to)
	   AND (p_after_id IS NULL OR e.id > p_after_id)
	 ORDER BY e.id
	 LIMIT least(greatest(coalesce(p_lim, 50), 1), 500)
$$;
--> statement-breakpoint

-- Walks one (tenant, month) chain in seq order and reports the first row that does not hold up: a seq gap,
-- a prev_hash that is not the previous row's hash (row 1: the previous month's last hash, or '\x00'), or a
-- stored hash that the canonical expression does not reproduce.
CREATE FUNCTION "audit"."verify_chain"(p_tenant_id uuid, p_month date)
RETURNS TABLE (ok boolean, "rows" bigint, first_bad_seq bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
DECLARE
	v_month date := date_trunc('month', p_month::timestamp)::date;
	v_prev bytea;
	v_expected_seq bigint := 1;
	v_count bigint := 0;
	v_bad bigint;
	r audit.audit_events%ROWTYPE;
BEGIN
	SELECT e.hash INTO v_prev
	  FROM audit.audit_events e
	 WHERE e.tenant_id = p_tenant_id AND e.chain_month < v_month
	 ORDER BY e.chain_month DESC, e.seq DESC
	 LIMIT 1;
	IF NOT FOUND THEN
		v_prev := '\x00'::bytea;
	END IF;

	FOR r IN
		SELECT * FROM audit.audit_events e
		 WHERE e.tenant_id = p_tenant_id AND e.chain_month = v_month
		 ORDER BY e.seq
	LOOP
		v_count := v_count + 1;
		IF v_bad IS NULL AND (
			r.seq <> v_expected_seq
			OR r.prev_hash <> v_prev
			OR r.hash <> audit.event_hash(r.prev_hash, r.id, r.tenant_id, r.chain_month, r.seq, r.occurred_at,
				r.actor_kind, r.actor_id, r.action, r.entity_type, r.entity_id, r.before, r.after, r.meta, r.ip,
				r.user_agent, r.correlation_id)
		) THEN
			v_bad := r.seq;
		END IF;
		v_prev := r.hash;
		v_expected_seq := r.seq + 1;
	END LOOP;

	ok := v_bad IS NULL;
	"rows" := v_count;
	first_bad_seq := v_bad;
	RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- Append-only, even for bos_owner: UPDATE and DELETE raise per row, TRUNCATE per statement.
CREATE FUNCTION "audit"."reject_change"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, audit, app
AS $$
BEGIN
	RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only" BEFORE UPDATE OR DELETE ON "audit"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit"."audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint

-- Privileges. init-dbs.sh's default privileges gave bos_app DML on both tables and USAGE/SELECT on the id
-- sequence the moment bos_owner created them (finding 6), so they are taken back explicitly.
REVOKE ALL ON "audit"."audit_events", "audit"."chain_seals" FROM "bos_app";
--> statement-breakpoint
REVOKE ALL ON SEQUENCE "audit"."audit_events_id_seq" FROM "bos_app";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "audit" TO "bos_app";
--> statement-breakpoint
-- Functions are executable by PUBLIC by default. Take that away from all of them, then let bos_app call only
-- the three public entry points. attach, append, capture_row, event_hash and reject_change stay with
-- bos_owner; the trigger still fires for bos_app (EXECUTE is checked when a trigger is created, not fired).
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "audit" FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
	"audit"."record"(text, text, text, jsonb, jsonb, jsonb),
	"audit"."read_events"(uuid, uuid, text, text, timestamptz, timestamptz, bigint, integer),
	"audit"."verify_chain"(uuid, date)
TO "bos_app";
--> statement-breakpoint

-- app.tenants is on the check-audit allowlist (it IS the tenant and has no tenant_id); organizations is not.
SELECT "audit"."attach"('app.organizations');
--> statement-breakpoint

-- Monthly seal (U2e). Run by the worker's audit.seal job for each tenant once a UTC month has closed.
-- bos_app has no privilege on chain_seals, so the seal is written by this SECURITY DEFINER function, which
-- writes only what the chain itself says: it verifies the month first and copies the tail of the chain.
-- A seal pins the month's length and last hash, so a later rewrite of the whole month (rehashing every row
-- with a superuser) no longer matches the seal.
--
-- sealed is false when the month has no rows or is already sealed (ON CONFLICT DO NOTHING), so a retried
-- job is harmless. last_seq is the month's last seq, or NULL for an empty month.
CREATE FUNCTION "audit"."seal"(p_tenant uuid, p_month date)
RETURNS TABLE (sealed boolean, last_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
#variable_conflict use_column
DECLARE
	-- Same normalisation as verify_chain and append (chain_month is the first day of the UTC month).
	v_month date := date_trunc('month', p_month::timestamp)::date;
	v_current date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
	v_ok boolean;
	v_bad bigint;
	v_last audit.audit_events%ROWTYPE;
	v_n bigint;
BEGIN
	IF p_tenant IS NULL OR p_month IS NULL THEN
		RAISE EXCEPTION 'audit.seal: tenant and month are required';
	END IF;
	-- The current month is still being written, and a future month has nothing to seal yet.
	IF v_month >= v_current THEN
		RAISE EXCEPTION 'audit.seal: % is not a closed UTC month (current month is %)',
			to_char(v_month, 'YYYY-MM'), to_char(v_current, 'YYYY-MM');
	END IF;

	-- The chain lock append() takes for this (tenant, month): waits for a writer that is still in flight in
	-- that month (a transaction that began before midnight UTC), so verify and the tail read see one state.
	PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text || to_char(v_month, 'YYYY-MM-DD'), 0));

	SELECT v.ok, v.first_bad_seq INTO v_ok, v_bad FROM audit.verify_chain(p_tenant, v_month) v;
	IF NOT v_ok THEN
		RAISE EXCEPTION 'audit.seal: chain of tenant % for % is broken at seq %; refusing to seal',
			p_tenant, to_char(v_month, 'YYYY-MM'), v_bad;
	END IF;

	SELECT * INTO v_last
	  FROM audit.audit_events e
	 WHERE e.tenant_id = p_tenant AND e.chain_month = v_month
	 ORDER BY e.seq DESC
	 LIMIT 1;
	IF NOT FOUND THEN
		sealed := false;
		last_seq := NULL;
		RETURN NEXT;
		RETURN;
	END IF;

	-- organization_id comes from the last row: chain_seals needs one, and the chain itself is tenant-wide.
	INSERT INTO audit.chain_seals AS s (tenant_id, organization_id, chain_month, last_seq, last_hash, sealed_at)
	VALUES (p_tenant, v_last.organization_id, v_month, v_last.seq, v_last.hash, now())
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS v_n = ROW_COUNT;

	sealed := v_n = 1;
	last_seq := v_last.seq;
	RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- The tenants that have at least one row in a month: the seal job's work list. bos_app cannot read
-- audit_events, so the worker asks through this definer function. It returns tenant ids only, no event data.
CREATE FUNCTION "audit"."tenants_with_rows"(p_month date)
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, audit, app
AS $$
	SELECT DISTINCT e.tenant_id
	  FROM audit.audit_events e
	 WHERE e.chain_month = date_trunc('month', p_month::timestamp)::date
	 ORDER BY e.tenant_id
$$;
--> statement-breakpoint

-- The schema-wide REVOKE above ran before these two existed, so they are revoked from PUBLIC one by one.
REVOKE EXECUTE ON FUNCTION "audit"."seal"(uuid, date), "audit"."tenants_with_rows"(date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "audit"."seal"(uuid, date), "audit"."tenants_with_rows"(date) TO "bos_app";
