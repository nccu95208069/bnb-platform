-- Production-only capacity migration for Supabase project brcszrkwkgiwatrxevkf.
-- This changes one attribute of the existing Iron Gate login role. It grants no
-- schema, table, function, or role privileges and does not alter credentials.
-- Reapplying after success is a no-op. A recreated or changed role fails closed.
DO $iron_gate_role_limit$
DECLARE
  target record;
  membership_count integer;
  membership_matches boolean;
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_WRONG_DATABASE_OR_EXECUTOR';
  END IF;
  IF current_setting('max_connections')::integer < 60 THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_DATABASE_CAPACITY_CHANGED';
  END IF;

  SELECT oid, rolconnlimit, rolcanlogin, rolinherit, rolsuper,
    rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolvaliduntil
    INTO target
    FROM pg_roles WHERE rolname = 'iron_gate_prod_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_ROLE_MISSING';
  END IF;
  IF target.oid::text <> '17768' OR
    target.rolcanlogin IS DISTINCT FROM true OR
    target.rolinherit IS DISTINCT FROM true OR
    target.rolsuper IS DISTINCT FROM false OR
    target.rolcreaterole IS DISTINCT FROM false OR
    target.rolcreatedb IS DISTINCT FROM false OR
    target.rolreplication IS DISTINCT FROM false OR
    target.rolbypassrls IS DISTINCT FROM false OR
    target.rolvaliduntil IS NOT NULL THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_ROLE_IDENTITY_CHANGED';
  END IF;

  SELECT count(*), bool_and(pg_get_userbyid(roleid) = 'iron_gate_runtime'
      AND admin_option IS false AND inherit_option IS true
      AND set_option IS true)
    INTO membership_count, membership_matches
    FROM pg_auth_members WHERE member = target.oid;
  IF membership_count <> 1 OR membership_matches IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_MEMBERSHIP_CHANGED';
  END IF;

  IF target.rolconnlimit = 4 THEN
    EXECUTE 'ALTER ROLE iron_gate_prod_app CONNECTION LIMIT 12';
  ELSIF target.rolconnlimit <> 12 THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_UNEXPECTED_CURRENT_LIMIT';
  END IF;

  PERFORM 1 FROM pg_roles WHERE oid = target.oid
    AND rolname = 'iron_gate_prod_app' AND rolconnlimit = 12;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IRON_GATE_ROLE_LIMIT_READBACK_FAILED';
  END IF;
END;
$iron_gate_role_limit$;
