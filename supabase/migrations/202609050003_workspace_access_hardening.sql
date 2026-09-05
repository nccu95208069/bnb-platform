ALTER FUNCTION public.set_workspace_member_updated_at() SET search_path = public;
ALTER FUNCTION public.workspace_role_permissions(public.workspace_member_role) SET search_path = public;

CREATE INDEX IF NOT EXISTS ix_workspace_member_invited_by
  ON public.workspace_member (invited_by)
  WHERE invited_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_workspace_member_property_property
  ON public.workspace_member_property (property_id);
CREATE INDEX IF NOT EXISTS ix_permission_audit_actor
  ON public.permission_audit_event (actor_auth_user_id)
  WHERE actor_auth_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_permission_audit_member
  ON public.permission_audit_event (member_id)
  WHERE member_id IS NOT NULL;

DROP POLICY IF EXISTS workspace_member_select_policy ON public.workspace_member;
CREATE POLICY workspace_member_select_policy
ON public.workspace_member FOR SELECT TO authenticated
USING (
  auth_user_id = (SELECT auth.uid())
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
        wm.auth_user_id = (SELECT auth.uid())
        OR public.is_workspace_owner(wm.tenant_id)
      )
  )
);
