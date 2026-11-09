-- 0030_approval_dept_head_step: the department-head approval step (P4 unit K1, kernel gap M8, AD11).
--
-- A workflow step of kind 'department_head' is approved by the head of the department named in the
-- request's departmentId fact (app.departments.head_user_id). When there is no head, or the head is in the
-- request's sod_user_ids (the requester), it goes to the step's fallback role (operations_head by default).
-- The router resolves this when it plans, and the stored step keeps what it resolved to:
--   * user_id  = the head, or
--   * role_key = the fallback role,
-- exactly one of the two, and never a group. Two approval_steps checks change:
--   * approval_steps_kind_check accepts 'department_head';
--   * approval_steps_target_check keeps the 0006 rule for role, group and user steps and adds the
--     department_head rule above.
-- NOT VALID then VALIDATE, the pattern of 0011 and 0017: existing rows are re-checked by the separate VALIDATE.

ALTER TABLE "app"."approval_steps" DROP CONSTRAINT "approval_steps_kind_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_kind_check" CHECK ("kind" in ('role', 'group', 'user', 'department_head')) NOT VALID;
--> statement-breakpoint

ALTER TABLE "app"."approval_steps" VALIDATE CONSTRAINT "approval_steps_kind_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_steps" DROP CONSTRAINT "approval_steps_target_check";
--> statement-breakpoint

ALTER TABLE "app"."approval_steps" ADD CONSTRAINT "approval_steps_target_check" CHECK (
	("kind" = 'group') = ("group_id" IS NOT NULL)
	AND CASE "kind"
		WHEN 'role' THEN "role_key" IS NOT NULL AND "user_id" IS NULL
		WHEN 'user' THEN "user_id" IS NOT NULL AND "role_key" IS NULL
		WHEN 'group' THEN "role_key" IS NULL AND "user_id" IS NULL
		WHEN 'department_head' THEN ("role_key" IS NOT NULL) <> ("user_id" IS NOT NULL)
		ELSE false
	END
) NOT VALID;
--> statement-breakpoint

ALTER TABLE "app"."approval_steps" VALIDATE CONSTRAINT "approval_steps_target_check";
