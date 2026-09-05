CREATE OR REPLACE FUNCTION public.workspace_role_permissions(
  p_role public.workspace_member_role
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'manage_members', p_role = 'owner',
    'edit_bookings', p_role IN ('owner', 'admin', 'housekeeper'),
    'record_payments', p_role IN ('owner', 'admin', 'housekeeper'),
    'cancel_bookings', p_role IN ('owner', 'admin'),
    'view_prices', p_role <> 'viewer_no_price'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_owner(p_tenant_id varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_member wm
    WHERE wm.tenant_id = p_tenant_id
      AND wm.auth_user_id = auth.uid()
      AND wm.status = 'active'
      AND wm.role = 'owner'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_workspace_admin(p_tenant_id varchar)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.workspace_member wm
    WHERE wm.tenant_id = p_tenant_id
      AND wm.auth_user_id = auth.uid()
      AND wm.status = 'active'
      AND wm.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.claim_workspace_membership()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'authentication_required' USING ERRCODE = '28000';
  END IF;

  SELECT lower(u.email), u.phone
    INTO v_email, v_phone
  FROM auth.users u
  WHERE u.id = v_uid;

  UPDATE public.workspace_member wm
  SET auth_user_id = v_uid,
      status = 'active',
      accepted_at = COALESCE(wm.accepted_at, now()),
      last_active_at = now()
  WHERE wm.auth_user_id = v_uid
     OR (
       wm.auth_user_id IS NULL
       AND wm.status = 'invited'
       AND (
         (v_email IS NOT NULL AND wm.email IS NOT NULL AND lower(wm.email) = v_email)
         OR (v_phone IS NOT NULL AND wm.phone_e164 = v_phone)
       )
     );

  RETURN public.get_my_access_context();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_access_context()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT jsonb_build_object(
    'memberships', COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', wm.id,
          'tenant_id', wm.tenant_id,
          'tenant_name', t.name,
          'display_name', wm.display_name,
          'email', wm.email,
          'phone', wm.phone_e164,
          'role', wm.role,
          'status', wm.status,
          'all_properties', wm.all_properties,
          'permissions', public.workspace_role_permissions(wm.role),
          'property_ids', CASE
            WHEN wm.all_properties THEN (
              SELECT COALESCE(jsonb_agg(p.id ORDER BY p.sort_order, p.created_at), '[]'::jsonb)
              FROM public.property p
              WHERE p.tenant_id = wm.tenant_id AND p.is_active
            )
            ELSE (
              SELECT COALESCE(jsonb_agg(wmp.property_id ORDER BY wmp.property_id), '[]'::jsonb)
              FROM public.workspace_member_property wmp
              WHERE wmp.member_id = wm.id
            )
          END
        )
        ORDER BY wm.created_at
      ),
      '[]'::jsonb
    )
  )
  FROM public.workspace_member wm
  JOIN public.tenant t ON t.id = wm.tenant_id
  WHERE wm.auth_user_id = auth.uid()
    AND wm.status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.list_workspace_members(p_tenant_id varchar)
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
        'id', wm.id,
        'display_name', wm.display_name,
        'email', wm.email,
        'phone', wm.phone_e164,
        'role', wm.role,
        'status', wm.status,
        'all_properties', wm.all_properties,
        'property_ids', CASE
          WHEN wm.all_properties THEN (
            SELECT COALESCE(jsonb_agg(p.id ORDER BY p.sort_order, p.created_at), '[]'::jsonb)
            FROM public.property p
            WHERE p.tenant_id = wm.tenant_id AND p.is_active
          )
          ELSE (
            SELECT COALESCE(jsonb_agg(wmp.property_id ORDER BY wmp.property_id), '[]'::jsonb)
            FROM public.workspace_member_property wmp
            WHERE wmp.member_id = wm.id
          )
        END,
        'permissions', public.workspace_role_permissions(wm.role),
        'invited_at', wm.invited_at,
        'accepted_at', wm.accepted_at,
        'last_active_at', wm.last_active_at
      )
      ORDER BY
        CASE wm.role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          WHEN 'housekeeper' THEN 2
          WHEN 'viewer' THEN 3
          ELSE 4
        END,
        wm.display_name
    ),
    '[]'::jsonb
  ) INTO v_result
  FROM public.workspace_member wm
  WHERE wm.tenant_id = p_tenant_id;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_workspace_member(
  p_tenant_id varchar,
  p_display_name text,
  p_role public.workspace_member_role,
  p_all_properties boolean,
  p_property_ids varchar[],
  p_member_id uuid DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_phone_e164 text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_member public.workspace_member%ROWTYPE;
  v_before jsonb;
  v_email text := NULLIF(lower(btrim(p_email)), '');
  v_phone text := NULLIF(btrim(p_phone_e164), '');
  v_existing_id uuid;
BEGIN
  IF NOT public.is_workspace_owner(p_tenant_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'owner_role_cannot_be_assigned' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(p_display_name), '') IS NULL THEN
    RAISE EXCEPTION 'display_name_required' USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION 'email_or_phone_required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_all_properties AND COALESCE(array_length(p_property_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'property_scope_required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_all_properties AND EXISTS (
    SELECT 1
    FROM unnest(p_property_ids) AS requested(property_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.property p
      WHERE p.id = requested.property_id
        AND p.tenant_id = p_tenant_id
        AND p.is_active
    )
  ) THEN
    RAISE EXCEPTION 'invalid_property_scope' USING ERRCODE = '22023';
  END IF;

  IF p_member_id IS NOT NULL THEN
    SELECT wm.* INTO v_member
    FROM public.workspace_member wm
    WHERE wm.id = p_member_id AND wm.tenant_id = p_tenant_id;
    IF v_member.id IS NULL THEN
      RAISE EXCEPTION 'member_not_found' USING ERRCODE = '22023';
    END IF;
    IF v_member.role = 'owner' THEN
      RAISE EXCEPTION 'owner_role_cannot_be_modified' USING ERRCODE = '22023';
    END IF;
    v_before := to_jsonb(v_member);
  ELSE
    SELECT wm.id INTO v_existing_id
    FROM public.workspace_member wm
    WHERE wm.tenant_id = p_tenant_id
      AND (
        (v_email IS NOT NULL AND wm.email IS NOT NULL AND lower(wm.email) = v_email)
        OR (v_phone IS NOT NULL AND wm.phone_e164 = v_phone)
      )
    ORDER BY wm.created_at
    LIMIT 1;

    IF v_existing_id IS NOT NULL THEN
      SELECT wm.* INTO v_member
      FROM public.workspace_member wm
      WHERE wm.id = v_existing_id;
      IF v_member.role = 'owner' THEN
        RAISE EXCEPTION 'owner_role_cannot_be_modified' USING ERRCODE = '22023';
      END IF;
      v_before := to_jsonb(v_member);
    END IF;
  END IF;

  IF v_member.id IS NULL THEN
    INSERT INTO public.workspace_member (
      tenant_id,
      display_name,
      email,
      phone_e164,
      role,
      status,
      all_properties,
      invited_by
    ) VALUES (
      p_tenant_id,
      btrim(p_display_name),
      v_email,
      v_phone,
      p_role,
      'invited',
      p_all_properties,
      auth.uid()
    )
    RETURNING * INTO v_member;
  ELSE
    UPDATE public.workspace_member wm
    SET display_name = btrim(p_display_name),
        email = v_email,
        phone_e164 = v_phone,
        role = p_role,
        all_properties = p_all_properties,
        status = CASE WHEN wm.status = 'suspended' THEN 'invited' ELSE wm.status END,
        invited_by = auth.uid(),
        invited_at = CASE WHEN wm.status = 'invited' THEN now() ELSE wm.invited_at END
    WHERE wm.id = v_member.id
    RETURNING * INTO v_member;
  END IF;

  DELETE FROM public.workspace_member_property
  WHERE member_id = v_member.id;

  IF NOT p_all_properties THEN
    INSERT INTO public.workspace_member_property (member_id, property_id)
    SELECT v_member.id, requested.property_id
    FROM unnest(p_property_ids) AS requested(property_id)
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.permission_audit_event (
    tenant_id,
    actor_auth_user_id,
    member_id,
    action,
    before_state,
    after_state
  ) VALUES (
    p_tenant_id,
    auth.uid(),
    v_member.id,
    CASE WHEN v_before IS NULL THEN 'member_invited' ELSE 'member_updated' END,
    v_before,
    to_jsonb(v_member)
  );

  RETURN jsonb_build_object(
    'id', v_member.id,
    'display_name', v_member.display_name,
    'email', v_member.email,
    'phone', v_member.phone_e164,
    'role', v_member.role,
    'status', v_member.status,
    'all_properties', v_member.all_properties,
    'permissions', public.workspace_role_permissions(v_member.role)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_workspace_member_status(
  p_member_id uuid,
  p_status public.workspace_member_status
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_member public.workspace_member%ROWTYPE;
  v_before jsonb;
BEGIN
  SELECT wm.* INTO v_member
  FROM public.workspace_member wm
  WHERE wm.id = p_member_id;

  IF v_member.id IS NULL THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = '22023';
  END IF;
  IF NOT public.is_workspace_owner(v_member.tenant_id) THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  IF v_member.role = 'owner' THEN
    RAISE EXCEPTION 'owner_cannot_be_suspended' USING ERRCODE = '22023';
  END IF;

  v_before := to_jsonb(v_member);

  UPDATE public.workspace_member wm
  SET status = p_status
  WHERE wm.id = p_member_id
  RETURNING * INTO v_member;

  INSERT INTO public.permission_audit_event (
    tenant_id,
    actor_auth_user_id,
    member_id,
    action,
    before_state,
    after_state
  ) VALUES (
    v_member.tenant_id,
    auth.uid(),
    v_member.id,
    'member_status_changed',
    v_before,
    to_jsonb(v_member)
  );

  RETURN jsonb_build_object(
    'id', v_member.id,
    'status', v_member.status
  );
END;
$$;

ALTER TABLE public.workspace_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_member_property ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_audit_event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workspace_member_select_policy ON public.workspace_member;
CREATE POLICY workspace_member_select_policy
ON public.workspace_member FOR SELECT TO authenticated
USING (
  auth_user_id = auth.uid()
  OR public.is_workspace_owner(tenant_id)
);

DROP POLICY IF EXISTS workspace_member_property_select_policy ON public.workspace_member_property;
CREATE POLICY workspace_member_property_select_policy
ON public.workspace_member_property FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.workspace_member wm
    WHERE wm.id = member_id
      AND (
        wm.auth_user_id = auth.uid()
        OR public.is_workspace_owner(wm.tenant_id)
      )
  )
);

DROP POLICY IF EXISTS permission_audit_select_policy ON public.permission_audit_event;
CREATE POLICY permission_audit_select_policy
ON public.permission_audit_event FOR SELECT TO authenticated
USING (public.is_workspace_owner(tenant_id));

REVOKE ALL ON public.workspace_member FROM anon;
REVOKE ALL ON public.workspace_member_property FROM anon;
REVOKE ALL ON public.permission_audit_event FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_member FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.workspace_member_property FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.permission_audit_event FROM authenticated;
GRANT SELECT ON public.workspace_member TO authenticated;
GRANT SELECT ON public.workspace_member_property TO authenticated;
GRANT SELECT ON public.permission_audit_event TO authenticated;

REVOKE ALL ON FUNCTION public.workspace_role_permissions(public.workspace_member_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_workspace_owner(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_workspace_admin(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_workspace_membership() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_access_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_workspace_members(varchar) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_workspace_member(varchar, text, public.workspace_member_role, boolean, varchar[], uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_workspace_member_status(uuid, public.workspace_member_status) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.workspace_role_permissions(public.workspace_member_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_owner(varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_workspace_admin(varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_workspace_membership() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_access_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_workspace_members(varchar) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_workspace_member(varchar, text, public.workspace_member_role, boolean, varchar[], uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_workspace_member_status(uuid, public.workspace_member_status) TO authenticated;
