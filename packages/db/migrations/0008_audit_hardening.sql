-- 0008_audit_hardening: review fixes to the audit chain of 0001 (P1 review R4, R5, R15, R27).
--
--   * R4  One chain lock per tenant (0001 locked per (tenant, month), so a late writer of last month and the
--         first writer of this month could both extend the chain: a fork at the month boundary). Under that
--         lock append() never writes into a month earlier than the tenant's latest one.
--   * R5  Hash v2: a JSON array over every field, organization_id included. v1 joined fields with an
--         unescaped \x1f, could not tell NULL from '', dropped the netmask (host(ip)) and left
--         organization_id out. hash_version tells verify_chain() which expression a row was written with,
--         so rows written before this migration still verify.
--   * R15 Seals are enforced: verify_chain() compares a sealed month with its seal, append() refuses a
--         sealed month, and chain_seals is append-only like audit_events.
--   * R27 Every SECURITY DEFINER function's search_path ends with pg_temp (otherwise pg_temp is searched
--         first and a caller's temp table or function could shadow ours), and append() refuses any
--         isolation level other than READ COMMITTED (a REPEATABLE READ snapshot taken before the lock
--         would not see the previous writer's row, and the chain would fork).
--
-- Runs as bos_owner. 0001 stays as it is: the dev database applied it already.

ALTER TABLE "audit"."audit_events" ADD COLUMN "hash_version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "audit"."audit_events" ADD CONSTRAINT "audit_events_hash_version_check" CHECK ("hash_version" in (1, 2));
--> statement-breakpoint

-- The v2 hash expression. append() writes with it and verify_chain() recomputes with it. jsonb_build_array
-- escapes every value and keeps NULL (JSON null) apart from '' (""), so no two different rows share a text.
-- Nothing may depend on a session setting: bytea goes in as hex (not bytea_output), times and dates through
-- to_char in UTC (not TimeZone or DateStyle), and inet as ::text, which keeps the netmask. The leading 2 is
-- the version, so a row cannot be passed off as another version's hash of the same fields.
CREATE FUNCTION "audit"."event_hash_v2"(
	p_prev_hash bytea, p_id bigint, p_tenant_id uuid, p_organization_id uuid, p_chain_month date, p_seq bigint,
	p_occurred_at timestamptz, p_actor_kind text, p_actor_id text, p_action text, p_entity_type text,
	p_entity_id text, p_before jsonb, p_after jsonb, p_meta jsonb, p_ip inet, p_user_agent text,
	p_correlation_id text
) RETURNS bytea
LANGUAGE sql STABLE
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
	SELECT sha256(convert_to(jsonb_build_array(
		2,
		encode(p_prev_hash, 'hex'),
		p_id,
		p_tenant_id,
		p_organization_id,
		to_char(p_chain_month, 'YYYY-MM-DD'),
		p_seq,
		to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
		p_actor_kind,
		p_actor_id,
		p_action,
		p_entity_type,
		p_entity_id,
		p_before,
		p_after,
		p_meta,
		p_ip::text,
		p_user_agent,
		p_correlation_id
	)::text, 'UTF8'))
$$;
--> statement-breakpoint

-- Dropped and re-created because the p_occurred_at default changes from now() to NULL. The schema-wide
-- REVOKE at the end takes PUBLIC's EXECUTE away again, so append stays owner-only.
DROP FUNCTION "audit"."append"(uuid, uuid, text, text, text, jsonb, jsonb, jsonb, timestamptz);
--> statement-breakpoint

-- Internal: appends one event to its tenant's chain (see 0001 for the bos.* settings).
--
-- Must stay VOLATILE: in READ COMMITTED each statement takes a fresh snapshot, so the tail read after the lock
-- sees what the previous lock holder committed. occurred_at is read from clock_timestamp() under the lock
-- (now() is the transaction start, which can be before the previous writer's row). p_occurred_at is for
-- owner-only tests that need a row in another month; even then the row goes into the tenant's latest month
-- if p_occurred_at is earlier, because a row in an older month would fork the chain.
CREATE FUNCTION "audit"."append"(
	p_tenant_id uuid, p_organization_id uuid, p_action text, p_entity_type text, p_entity_id text,
	p_before jsonb, p_after jsonb, p_meta jsonb, p_occurred_at timestamptz DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
DECLARE
	-- An unset setting reads as NULL, or as '' once set_config has touched it on this pooled connection.
	v_actor_id text := nullif(current_setting('bos.actor_id', true), '');
	v_actor_kind text := nullif(current_setting('bos.actor_kind', true), '');
	v_correlation_id text := coalesce(nullif(current_setting('bos.correlation_id', true), ''), '');
	v_ip inet := nullif(current_setting('bos.ip', true), '')::inet;
	v_user_agent text := nullif(current_setting('bos.user_agent', true), '');
	v_occurred_at timestamptz;
	v_latest date;
	v_month date;
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
	IF current_setting('transaction_isolation') <> 'read committed' THEN
		RAISE EXCEPTION 'audit: append needs READ COMMITTED, this transaction is %; a snapshot older than the chain lock would fork the chain',
			upper(current_setting('transaction_isolation'));
	END IF;

	-- One writer per tenant at a time, held until COMMIT, so seq is gap-free and the chain is one line across
	-- months. seal() takes the same lock.
	PERFORM pg_advisory_xact_lock(hashtextextended('audit.chain:' || p_tenant_id::text, 0));

	v_occurred_at := coalesce(p_occurred_at, clock_timestamp());

	SELECT e.chain_month, e.seq, e.hash INTO v_latest, v_seq, v_prev
	  FROM audit.audit_events e
	 WHERE e.tenant_id = p_tenant_id
	 ORDER BY e.chain_month DESC, e.seq DESC
	 LIMIT 1;
	IF NOT FOUND THEN
		v_seq := 0;
		v_prev := '\x00'::bytea;
	END IF;

	-- greatest() ignores the NULL of a tenant with no rows yet.
	v_month := greatest(date_trunc('month', v_occurred_at AT TIME ZONE 'UTC')::date, v_latest);
	IF v_month > v_latest THEN
		-- First row of a new month: seq restarts, prev_hash links to the previous month's tail.
		v_seq := 0;
	END IF;

	IF EXISTS (SELECT 1 FROM audit.chain_seals s WHERE s.tenant_id = p_tenant_id AND s.chain_month = v_month) THEN
		RAISE EXCEPTION 'audit: the chain of tenant % for % is sealed and takes no more rows',
			p_tenant_id, to_char(v_month, 'YYYY-MM');
	END IF;

	-- The id is part of the hash, so it is taken from the identity sequence before hashing and inserted with
	-- OVERRIDING SYSTEM VALUE. (Insert-then-update would need UPDATE on an append-only table.)
	v_id := nextval(pg_get_serial_sequence('audit.audit_events', 'id'));
	v_seq := v_seq + 1;

	INSERT INTO audit.audit_events (
		id, tenant_id, organization_id, chain_month, seq, occurred_at, actor_kind, actor_id, action,
		entity_type, entity_id, before, after, meta, ip, user_agent, correlation_id, prev_hash, hash, hash_version
	) OVERRIDING SYSTEM VALUE VALUES (
		v_id, p_tenant_id, p_organization_id, v_month, v_seq, v_occurred_at, v_actor_kind, v_actor_id, p_action,
		p_entity_type, p_entity_id, p_before, p_after, p_meta, v_ip, v_user_agent, v_correlation_id, v_prev,
		audit.event_hash_v2(v_prev, v_id, p_tenant_id, p_organization_id, v_month, v_seq, v_occurred_at,
			v_actor_kind, v_actor_id, p_action, p_entity_type, p_entity_id, p_before, p_after, p_meta, v_ip,
			v_user_agent, v_correlation_id),
		2
	);
	RETURN v_id;
END;
$$;
--> statement-breakpoint

-- Same as 0001, with catalog names schema-qualified and pg_temp last in the search_path.
CREATE OR REPLACE FUNCTION "audit"."capture_row"() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
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
		  FROM pg_catalog.pg_index i
		 CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
		  JOIN pg_catalog.pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
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

-- Same as 0001, except that occurred_at is left to append(), which reads clock_timestamp() under the lock.
CREATE OR REPLACE FUNCTION "audit"."record"(
	p_action text, p_entity_type text, p_entity_id text, p_before jsonb, p_after jsonb, p_meta jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
DECLARE
	v_tenant_id uuid := nullif(current_setting('bos.tenant_id', true), '')::uuid;
	v_organization_id uuid := nullif(current_setting('bos.organization_id', true), '')::uuid;
BEGIN
	IF v_tenant_id IS NULL OR v_organization_id IS NULL THEN
		RAISE EXCEPTION 'audit: bos.tenant_id / bos.organization_id are not set; call record() inside withTx()';
	END IF;
	RETURN audit.append(v_tenant_id, v_organization_id, p_action, p_entity_type, p_entity_id,
		p_before, p_after, p_meta);
END;
$$;
--> statement-breakpoint

-- Dropped and re-created because the result gains the reason column (CREATE OR REPLACE cannot change a
-- return type). bos_app's EXECUTE is granted again at the end.
DROP FUNCTION "audit"."verify_chain"(uuid, date);
--> statement-breakpoint

-- Walks one (tenant, month) chain in seq order and reports the first row that does not hold up, then, if the
-- month is sealed, compares the chain with its seal. reason is NULL when ok, else one of:
--   prev_hash_mismatch   the row does not follow the previous one: a seq gap, or a prev_hash that is not the
--                        previous row's hash (row 1: the previous month's last hash, or '\x00'). A deleted
--                        row shows up here, at the row after it.
--   hash_mismatch        the stored hash is not what the row's hash_version expression gives for its fields.
--   seal_count_mismatch  the month has more or fewer rows than its seal; first_bad_seq is the first seq that
--                        is missing or was added after the seal.
--   seal_hash_mismatch   same length, but the last hash is not the sealed one (the month was rehashed).
CREATE FUNCTION "audit"."verify_chain"(p_tenant_id uuid, p_month date)
RETURNS TABLE (ok boolean, "rows" bigint, first_bad_seq bigint, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
DECLARE
	v_month date := date_trunc('month', p_month::timestamp)::date;
	v_prev bytea;
	v_expected_seq bigint := 1;
	v_count bigint := 0;
	v_bad bigint;
	v_reason text;
	v_hash bytea;
	v_seal audit.chain_seals%ROWTYPE;
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
		IF v_bad IS NULL THEN
			IF r.seq <> v_expected_seq OR r.prev_hash IS DISTINCT FROM v_prev THEN
				v_bad := r.seq;
				v_reason := 'prev_hash_mismatch';
			ELSE
				-- An unknown version gives NULL, and IS DISTINCT FROM makes that a mismatch, not a pass.
				v_hash := CASE r.hash_version
					WHEN 1 THEN audit.event_hash(r.prev_hash, r.id, r.tenant_id, r.chain_month, r.seq,
						r.occurred_at, r.actor_kind, r.actor_id, r.action, r.entity_type, r.entity_id, r.before,
						r.after, r.meta, r.ip, r.user_agent, r.correlation_id)
					WHEN 2 THEN audit.event_hash_v2(r.prev_hash, r.id, r.tenant_id, r.organization_id,
						r.chain_month, r.seq, r.occurred_at, r.actor_kind, r.actor_id, r.action, r.entity_type,
						r.entity_id, r.before, r.after, r.meta, r.ip, r.user_agent, r.correlation_id)
				END;
				IF r.hash IS DISTINCT FROM v_hash THEN
					v_bad := r.seq;
					v_reason := 'hash_mismatch';
				END IF;
			END IF;
		END IF;
		v_prev := r.hash;
		v_expected_seq := r.seq + 1;
	END LOOP;

	-- The rows hold together; a sealed month must also still be exactly what was sealed. Without this, a
	-- deleted last row, or a whole month rehashed by a superuser, would still verify.
	IF v_bad IS NULL THEN
		SELECT * INTO v_seal
		  FROM audit.chain_seals s
		 WHERE s.tenant_id = p_tenant_id AND s.chain_month = v_month;
		IF FOUND THEN
			IF v_count <> v_seal.last_seq THEN
				v_bad := least(v_count, v_seal.last_seq) + 1;
				v_reason := 'seal_count_mismatch';
			ELSIF v_prev IS DISTINCT FROM v_seal.last_hash THEN
				v_bad := v_seal.last_seq;
				v_reason := 'seal_hash_mismatch';
			END IF;
		END IF;
	END IF;

	ok := v_bad IS NULL;
	"rows" := v_count;
	first_bad_seq := v_bad;
	reason := v_reason;
	RETURN NEXT;
END;
$$;
--> statement-breakpoint

-- Same as 0001, except: it takes append()'s per-tenant lock, and it reports the reason when it refuses. A
-- month that is already sealed is re-checked against its seal by verify_chain(), so a re-seal after the
-- month changed raises here instead of quietly reporting sealed=false.
CREATE OR REPLACE FUNCTION "audit"."seal"(p_tenant uuid, p_month date)
RETURNS TABLE (sealed boolean, last_seq bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
#variable_conflict use_column
DECLARE
	-- Same normalisation as verify_chain and append (chain_month is the first day of the UTC month).
	v_month date := date_trunc('month', p_month::timestamp)::date;
	v_current date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
	v_ok boolean;
	v_bad bigint;
	v_reason text;
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

	-- append()'s chain lock: waits for a writer still in flight, so verify and the tail read see one state.
	PERFORM pg_advisory_xact_lock(hashtextextended('audit.chain:' || p_tenant::text, 0));

	SELECT v.ok, v.first_bad_seq, v.reason INTO v_ok, v_bad, v_reason FROM audit.verify_chain(p_tenant, v_month) v;
	IF NOT v_ok THEN
		RAISE EXCEPTION 'audit.seal: chain of tenant % for % is broken at seq %; refusing to seal (%)',
			p_tenant, to_char(v_month, 'YYYY-MM'), v_bad, v_reason;
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

-- Now shared by audit_events and chain_seals, so the message names the table.
CREATE OR REPLACE FUNCTION "audit"."reject_change"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, audit, app, pg_temp
AS $$
BEGIN
	RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint

-- A seal is evidence too: rewriting or deleting it would let a rewritten month verify again.
CREATE TRIGGER "chain_seals_append_only" BEFORE UPDATE OR DELETE ON "audit"."chain_seals"
FOR EACH ROW EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint
CREATE TRIGGER "chain_seals_no_truncate" BEFORE TRUNCATE ON "audit"."chain_seals"
FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_change"();
--> statement-breakpoint

-- The functions whose bodies do not change only get pg_temp at the end of their search_path.
ALTER FUNCTION "audit"."attach"(regclass, text[], text[]) SET search_path = pg_catalog, audit, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION "audit"."read_events"(uuid, uuid, text, text, timestamptz, timestamptz, bigint, integer)
	SET search_path = pg_catalog, audit, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION "audit"."tenants_with_rows"(date) SET search_path = pg_catalog, audit, app, pg_temp;
--> statement-breakpoint
ALTER FUNCTION "audit"."event_hash"(bytea, bigint, uuid, date, bigint, timestamptz, text, text, text, text,
	text, jsonb, jsonb, jsonb, inet, text, text) SET search_path = pg_catalog, audit, app, pg_temp;
--> statement-breakpoint

-- Privileges. New and re-created functions are executable by PUBLIC by default, so take that away from all
-- of them again; CREATE OR REPLACE and ALTER kept bos_app's grants on record, read_events, seal and
-- tenants_with_rows. verify_chain was dropped, so bos_app gets it back. append, event_hash_v2 and the
-- rest stay with bos_owner.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA "audit" FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "audit"."verify_chain"(uuid, date) TO "bos_app";

-- R16 privileges (FIX-C1b) below
