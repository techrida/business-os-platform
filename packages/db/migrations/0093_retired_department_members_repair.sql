-- 0093_retired_department_members_repair: members a retired department left behind are unassigned (FX-Q3).
--
-- Before the retire fix, retiring a department unassigned only its active members: an invited or inactive member
-- kept the retired department and its level in app.user_entities. Access ignores a retired department, but Check a
-- person still reads the membership. Each such membership (department status retired, user not active) gets what
-- retire now does with no destination: department_id NULL and level staff (0079's check: a head needs a department).
--   * One `department.member.removed` event per repaired member, shaped as the retire route writes it (entity the
--     department, before and after its department and level, meta the user), with reason
--     `retired_department_repair`. The user_entities row audit (0013, re-attached with level in 0079) also records
--     the change, both as system:migration-0093.
--   * An active member of a retired department is not touched: retire never left one behind, and moving an active
--     person is an admin choice. The count is RAISE NOTICEd.
-- Running it again finds nothing: a repaired membership no longer names the retired department.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction. bos.tenant_id and bos.organization_id are set
-- per membership in the loop (audit.record needs both) and cleared after it.
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0093', true),
	set_config('bos.correlation_id', 'migration-0093:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

DO $$
DECLARE
	member record;
	v_repaired bigint := 0;
	v_active_left bigint;
BEGIN
	FOR member IN
		SELECT ue."id", ue."tenant_id", ue."organization_id", ue."user_id", ue."department_id", ue."level"
		FROM "app"."user_entities" ue
		JOIN "app"."departments" d
			ON d."tenant_id" = ue."tenant_id" AND d."organization_id" = ue."organization_id" AND d."id" = ue."department_id"
		JOIN "app"."users" u ON u."tenant_id" = ue."tenant_id" AND u."id" = ue."user_id"
		WHERE d."status" = 'retired'
			AND u."status" <> 'active'
		ORDER BY ue."tenant_id", ue."organization_id", ue."department_id", ue."user_id"
		FOR UPDATE OF ue
	LOOP
		PERFORM set_config('bos.tenant_id', member."tenant_id"::text, true);
		PERFORM set_config('bos.organization_id', member."organization_id"::text, true);

		UPDATE "app"."user_entities"
		SET "department_id" = NULL, "level" = 'staff'
		WHERE "id" = member."id" AND "department_id" = member."department_id";

		PERFORM audit.record(
			'department.member.removed',
			'departments',
			member."department_id"::text,
			jsonb_build_object('departmentId', member."department_id", 'level', member."level"),
			jsonb_build_object('departmentId', NULL, 'level', 'staff'),
			jsonb_build_object('userId', member."user_id", 'reason', 'retired_department_repair')
		);
		v_repaired := v_repaired + 1;
	END LOOP;

	PERFORM set_config('bos.tenant_id', '', true);
	PERFORM set_config('bos.organization_id', '', true);

	SELECT count(*) INTO v_active_left
	FROM "app"."user_entities" ue
	JOIN "app"."departments" d
		ON d."tenant_id" = ue."tenant_id" AND d."organization_id" = ue."organization_id" AND d."id" = ue."department_id"
	JOIN "app"."users" u ON u."tenant_id" = ue."tenant_id" AND u."id" = ue."user_id"
	WHERE d."status" = 'retired' AND u."status" = 'active';

	RAISE NOTICE 'migration-0093: invited or inactive members unassigned from retired departments=%, active members still in a retired department (left for an admin)=%',
		v_repaired, v_active_left;
END
$$;
