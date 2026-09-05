create extension if not exists pgcrypto;

DO $$
BEGIN
  CREATE TYPE public.workspace_member_role AS ENUM (
    'owner',
    'admin',
    'housekeeper',
    'viewer',
    'viewer_no_price'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE public.workspace_member_status AS ENUM (
    'invited',
    'active',
    'suspended'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.workspace_member (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  auth_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  display_name text NOT NULL,
  email text NULL,
  phone_e164 text NULL,
  role public.workspace_member_role NOT NULL DEFAULT 'viewer',
  status public.workspace_member_status NOT NULL DEFAULT 'invited',
  all_properties boolean NOT NULL DEFAULT true,
  invited_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NULL,
  last_active_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_member_has_identity CHECK (
    auth_user_id IS NOT NULL OR email IS NOT NULL OR phone_e164 IS NOT NULL
  ),
  CONSTRAINT workspace_member_email_not_blank CHECK (
    email IS NULL OR btrim(email) <> ''
  ),
  CONSTRAINT workspace_member_phone_not_blank CHECK (
    phone_e164 IS NULL OR btrim(phone_e164) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_member_tenant_auth_user
  ON public.workspace_member (tenant_id, auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_member_tenant_email
  ON public.workspace_member (tenant_id, lower(email))
  WHERE email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_workspace_member_tenant_phone
  ON public.workspace_member (tenant_id, phone_e164)
  WHERE phone_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_workspace_member_auth_user
  ON public.workspace_member (auth_user_id);

CREATE TABLE IF NOT EXISTS public.workspace_member_property (
  member_id uuid NOT NULL REFERENCES public.workspace_member(id) ON DELETE CASCADE,
  property_id varchar NOT NULL REFERENCES public.property(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, property_id)
);

CREATE TABLE IF NOT EXISTS public.permission_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  actor_auth_user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  member_id uuid NULL REFERENCES public.workspace_member(id) ON DELETE SET NULL,
  action text NOT NULL,
  before_state jsonb NULL,
  after_state jsonb NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_permission_audit_event_tenant_created
  ON public.permission_audit_event (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.set_workspace_member_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_member_set_updated_at ON public.workspace_member;
CREATE TRIGGER workspace_member_set_updated_at
BEFORE UPDATE ON public.workspace_member
FOR EACH ROW EXECUTE FUNCTION public.set_workspace_member_updated_at();

ALTER TABLE IF EXISTS public.stay_unit
  ADD COLUMN IF NOT EXISTS extra_guest_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_bed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pet_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS baby_supplies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS service_note text NULL;

DO $$
BEGIN
  ALTER TABLE public.stay_unit
    ADD CONSTRAINT stay_unit_extra_guest_nonnegative CHECK (extra_guest_count >= 0),
    ADD CONSTRAINT stay_unit_extra_bed_nonnegative CHECK (extra_bed_count >= 0),
    ADD CONSTRAINT stay_unit_pet_nonnegative CHECK (pet_count >= 0),
    ADD CONSTRAINT stay_unit_baby_supplies_array CHECK (jsonb_typeof(baby_supplies) = 'array');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE IF EXISTS public.bookings
  ADD COLUMN IF NOT EXISTS extra_guest_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_bed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pet_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS baby_supplies jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS service_note text NULL;
