-- The approval exclusion list needs every distinct editor, including actors beyond the audit UI's page limit.
-- Exact scope and entity predicates use audit_events_entity_idx. No payloads or chain data leave the database.
CREATE FUNCTION audit.entity_user_actors(p_entity_type text, p_entity_id text, p_actions text[])
RETURNS TABLE(actor_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, audit, pg_temp
AS $$
  SELECT DISTINCT e.actor_id
  FROM audit.audit_events e
  WHERE e.tenant_id = nullif(current_setting('bos.tenant_id', true), '')::uuid
    AND e.organization_id = nullif(current_setting('bos.organization_id', true), '')::uuid
    AND e.entity_type = p_entity_type AND e.entity_id = p_entity_id
    AND e.action = ANY(p_actions) AND e.actor_kind = 'user' AND e.actor_id <> ''
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.entity_user_actors(text, text, text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.entity_user_actors(text, text, text[]) TO bos_app;
