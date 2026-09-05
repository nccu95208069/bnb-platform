CREATE OR REPLACE FUNCTION public.upsert_workspace_member(
  p_tenant_id varchar,
  p_display_name text,
  p_email text DEFAULT NULL,
  p_phone_e164 text DEFAULT NULL,
  p_role public.workspace_member_role DEFAULT 'viewer',
  p_all_properties boolean DEFAULT true,
  p_property_ids varchar[] DEFAULT ARRAY[]::varchar[]
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT public.save_workspace_member(
    p_tenant_id,
    p_display_name,
    p_role,
    p_all_properties,
    p_property_ids,
    NULL,
    p_email,
    p_phone_e164
  );
$$;

CREATE OR REPLACE FUNCTION public.list_workspace_properties(p_tenant_id varchar)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT public.is_workspace_owner(p_tenant_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'name', p.name,
        'timezone', p.timezone,
        'sort_order', p.sort_order
      ) ORDER BY p.sort_order, p.created_at
    ),
    '[]'::jsonb
  ) INTO v_result
  FROM public.property p
  WHERE p.tenant_id = p_tenant_id
    AND p.is_active;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_workspace_member(
  varchar,
  text,
  text,
  text,
  public.workspace_member_role,
  boolean,
  varchar[]
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_workspace_properties(varchar) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.upsert_workspace_member(
  varchar,
  text,
  text,
  text,
  public.workspace_member_role,
  boolean,
  varchar[]
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspace_properties(varchar) TO authenticated;
