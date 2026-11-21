-- 0161_approval_actions_seq: a stable order for approval actions that share a timestamp (round 5, P5).
--
-- Every action row of one service transaction gets the same created_at (the service clock), and the id is a random
-- uuid, so ordering by (created_at, id) could show a block before the submit or approve that caused it. `seq` is
-- an insertion counter: the history now orders by (created_at, seq).
--
-- * GENERATED ALWAYS: nobody writes or edits it, so it is the order the rows were inserted in. Postgres draws an
--   identity value without a privilege check on its sequence, so bos_app's table-level INSERT is enough and needs
--   no new grant; bos_app keeps no UPDATE or DELETE here (0006).
-- * Existing rows are numbered in the table's physical order when the column is added. That order is not
--   guaranteed to be insertion order for old ties, which is acceptable: those rows already showed in id order.
-- * The approval_actions_guard trigger (0011) reads only action, request_id and the actor columns, so it is
--   unaffected. Adding the column fires no row trigger.
-- DDL only: no rows are written through the audit trigger, so no audit actor is needed.

ALTER TABLE "app"."approval_actions" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL;
