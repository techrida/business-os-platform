-- Titles belong to the staff membership of a legal entity; permission roles are never titles.
ALTER TABLE app.user_entities ADD COLUMN job_title text CHECK (length(job_title) <= 200);
--> statement-breakpoint
-- Null preserves existing test memos without inventing historical people or letterhead.
ALTER TABLE app.test_memos ADD COLUMN template jsonb CHECK (template IS NULL OR jsonb_typeof(template) = 'object');
