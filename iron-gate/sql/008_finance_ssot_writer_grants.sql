-- W2: runtime writes remain closed until an administrator admits a property.
-- The initial Offland release seeds that scope privately at connector cutover.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS iron_gate.finance_write_scope (
  property_id uuid PRIMARY KEY REFERENCES iron_gate.property_state(property_id),
  mode text NOT NULL CHECK (mode IN ('general_only','full')),
  actor_ref text NOT NULL DEFAULT COALESCE(
    NULLIF(current_setting('iron_gate.actor_ref', true), ''),current_user)
    CHECK (length(actor_ref) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS finance_write_scope_immutable ON iron_gate.finance_write_scope;
CREATE TRIGGER finance_write_scope_immutable
  BEFORE UPDATE OR DELETE ON iron_gate.finance_write_scope
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_immutable_row();
REVOKE ALL ON iron_gate.finance_write_scope
  FROM PUBLIC, anon, authenticated, iron_gate_runtime;
-- No runtime privilege is useful until a private administrator seeds exactly
-- the reviewed property. Reject a pre-existing connector, document or grant.
LOCK TABLE iron_gate.finance_write_scope,iron_gate.finance_connector,
  iron_gate.finance_document,iron_gate.credentials IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM iron_gate.finance_write_scope) OR
    EXISTS (SELECT 1 FROM iron_gate.finance_connector) OR
    EXISTS (SELECT 1 FROM iron_gate.finance_document) OR
    EXISTS (SELECT 1 FROM iron_gate.credentials
      WHERE grant_json ? 'financeSourceInstanceId')
    THEN RAISE EXCEPTION 'FINANCE_WRITE_SCOPE_NOT_EMPTY'; END IF;
END $$;
CREATE OR REPLACE FUNCTION iron_gate.finance_write_scope_mode(target_property uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.mode FROM iron_gate.finance_write_scope s
    WHERE s.property_id = target_property AND
      target_property::text = current_setting('iron_gate.property_id', true)
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_write_scope_mode(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_write_scope_mode(uuid)
  TO iron_gate_runtime;
CREATE OR REPLACE FUNCTION iron_gate.finance_write_scope_allowed(target_property uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp AS $$
  SELECT iron_gate.finance_write_scope_mode(target_property) IS NOT NULL
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_write_scope_allowed(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_write_scope_allowed(uuid)
  TO iron_gate_runtime;

CREATE OR REPLACE FUNCTION iron_gate.finance_general_connector_allowed(
  target_property uuid,target_source uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT target_property::text = current_setting('iron_gate.property_id', true)
    AND EXISTS (SELECT 1 FROM iron_gate.finance_connector c
      WHERE c.property_id=target_property AND c.source_instance_id=target_source
        AND c.source_system IN ('os_manual','line_finance'))
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_general_connector_allowed(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_general_connector_allowed(uuid,uuid)
  TO iron_gate_runtime;

CREATE OR REPLACE FUNCTION iron_gate.finance_general_document_allowed(
  target_property uuid,target_document uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT target_property::text = current_setting('iron_gate.property_id', true)
    AND EXISTS (SELECT 1 FROM iron_gate.finance_document d
      WHERE d.property_id=target_property AND d.id=target_document
        AND d.kind='money' AND d.source_system IN ('os_manual','line_finance')
        -- A later administrator may import older OS/LINE documents. They do not
        -- become general entries merely because their source system matches.
        AND NOT EXISTS (SELECT 1 FROM iron_gate.finance_allocation a
          JOIN iron_gate.finance_event e ON e.property_id=a.property_id
            AND e.id=a.event_id
          WHERE e.property_id=d.property_id AND e.document_id=d.id)
        AND NOT EXISTS (SELECT 1 FROM iron_gate.finance_event e
          WHERE e.property_id=d.property_id AND e.document_id=d.id
            AND (
              (e.event_kind='property_receipt' AND e.receipt_purpose='other'
                AND e.reverses_event_id IS NULL AND
                (e.category_kind IS NULL OR e.category_kind='income'))
              OR (e.event_kind='expense_paid' AND e.receipt_purpose IS NULL
                AND e.reverses_event_id IS NULL AND
                (e.category_kind IS NULL OR e.category_kind='expense'))
              OR (e.event_kind='reversal' AND e.reverses_event_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM iron_gate.finance_event prior
                  WHERE prior.property_id=e.property_id AND
                    prior.document_id=e.document_id AND prior.id=e.reverses_event_id
                    AND e.receipt_purpose IS NOT DISTINCT FROM prior.receipt_purpose
                    AND e.category_kind IS NOT DISTINCT FROM prior.category_kind
                    AND e.category_code IS NOT DISTINCT FROM prior.category_code
                    AND ((prior.event_kind='property_receipt' AND
                      prior.receipt_purpose='other') OR
                      (prior.event_kind='expense_paid' AND
                        prior.receipt_purpose IS NULL))))) IS NOT TRUE
        ))
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_general_document_allowed(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_general_document_allowed(uuid,uuid)
  TO iron_gate_runtime;

-- This helper uses the table owner's privilege only to inspect the immutable
-- prior event. It returns a boolean and cannot alter ledger rows.
CREATE OR REPLACE FUNCTION iron_gate.finance_general_event_allowed(
  target_property uuid,target_document uuid,target_kind text,
  target_purpose text,target_reversed uuid,
  target_category_kind text,target_category_code text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT target_property::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_general_document_allowed(target_property,target_document)
    AND (
      (target_kind='property_receipt' AND target_purpose='other'
        AND target_reversed IS NULL AND
        (target_category_kind IS NULL OR target_category_kind='income'))
      OR (target_kind='expense_paid' AND target_purpose IS NULL
        AND target_reversed IS NULL AND
        (target_category_kind IS NULL OR target_category_kind='expense'))
      OR (target_kind='reversal' AND target_reversed IS NOT NULL
        AND EXISTS (SELECT 1 FROM iron_gate.finance_event prior
          WHERE prior.property_id=target_property AND
            prior.document_id=target_document AND prior.id=target_reversed
            AND target_purpose IS NOT DISTINCT FROM prior.receipt_purpose
            AND target_category_kind IS NOT DISTINCT FROM prior.category_kind
            AND target_category_code IS NOT DISTINCT FROM prior.category_code
            AND ((prior.event_kind='property_receipt' AND
              prior.receipt_purpose='other') OR
              (prior.event_kind='expense_paid' AND prior.receipt_purpose IS NULL))))
    )
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_general_event_allowed(
  uuid,uuid,text,text,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_general_event_allowed(
  uuid,uuid,text,text,uuid,text,text) TO iron_gate_runtime;

CREATE OR REPLACE FUNCTION iron_gate.finance_general_attribution_allowed(
  target_property uuid,target_event uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT target_property::text = current_setting('iron_gate.property_id', true)
    AND EXISTS (SELECT 1 FROM iron_gate.finance_event e
      WHERE e.property_id=target_property AND e.id=target_event
        AND iron_gate.finance_general_document_allowed(e.property_id,e.document_id)
        AND (e.event_kind='expense_paid' OR
          (e.event_kind='reversal' AND EXISTS (
            SELECT 1 FROM iron_gate.finance_event prior
            WHERE prior.property_id=e.property_id AND prior.id=e.reverses_event_id
              AND prior.document_id=e.document_id AND
              prior.event_kind='expense_paid'))))
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_general_attribution_allowed(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_general_attribution_allowed(uuid,uuid)
  TO iron_gate_runtime;

-- Restrictive policies intersect every current and later permissive finance
-- write policy. A table-level GRANT alone cannot write a row for another property.
DO $$
DECLARE t text; general_check text; general_update_check text; mode_check text;
BEGIN
  FOR t IN SELECT tablename::text FROM pg_tables
    WHERE schemaname='iron_gate' AND tablename LIKE 'finance_%'
      AND tablename <> 'finance_write_scope' LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema='iron_gate' AND table_name=t AND column_name='property_id')
      THEN RAISE EXCEPTION 'FINANCE_WRITE_SCOPE_TABLE_UNSUPPORTED: %', t; END IF;
    EXECUTE format('DROP POLICY IF EXISTS finance_write_scope_insert ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_write_scope_insert ON iron_gate.%I AS RESTRICTIVE FOR INSERT TO iron_gate_runtime WITH CHECK (iron_gate.finance_write_scope_allowed(property_id))', t);
    EXECUTE format('DROP POLICY IF EXISTS finance_write_scope_update ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_write_scope_update ON iron_gate.%I AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime USING (iron_gate.finance_write_scope_allowed(property_id)) WITH CHECK (iron_gate.finance_write_scope_allowed(property_id))', t);
    mode_check := 'iron_gate.finance_write_scope_mode(property_id)';
    general_check := CASE t
      WHEN 'finance_document' THEN
        'kind=''money'' AND source_system IN (''os_manual'',''line_finance'')'
      WHEN 'finance_revision' THEN
        'action IN (''create'',''amend'',''void'') AND iron_gate.finance_general_document_allowed(property_id,document_id)'
      WHEN 'finance_event' THEN
        'iron_gate.finance_general_event_allowed(property_id,document_id,event_kind,receipt_purpose,reverses_event_id,category_kind,category_code)'
      WHEN 'finance_category' THEN
        'code ~ ''^custom_[a-z0-9_]{1,57}$'''
      WHEN 'finance_outbox' THEN
        'source_kind IN (''document_revision'',''category'')'
      WHEN 'finance_expense_attribution' THEN
        'iron_gate.finance_general_attribution_allowed(property_id,event_id)'
      WHEN 'finance_request_receipt' THEN
        'iron_gate.finance_general_connector_allowed(property_id,source_instance_id)'
      ELSE 'false' END;
    EXECUTE format('DROP POLICY IF EXISTS finance_general_mode_insert ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_general_mode_insert ON iron_gate.%I AS RESTRICTIVE FOR INSERT TO iron_gate_runtime WITH CHECK (%s=''full'' OR (%s=''general_only'' AND (%s)))',
      t,mode_check,mode_check,general_check);
    EXECUTE format('DROP POLICY IF EXISTS finance_general_mode_update ON iron_gate.%I', t);
    general_update_check := CASE WHEN t='finance_document' THEN
      'iron_gate.finance_general_document_allowed(property_id,id)'
      ELSE general_check END;
    EXECUTE format('CREATE POLICY finance_general_mode_update ON iron_gate.%I AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime USING (%s=''full'' OR (%s=''general_only'' AND (%s))) WITH CHECK (%s=''full'' OR (%s=''general_only'' AND (%s)))',
      t,mode_check,mode_check,general_update_check,mode_check,mode_check,general_update_check);
  END LOOP;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_document','finance_revision','finance_event','finance_allocation',
    'finance_expense_attribution','finance_request_receipt','finance_outbox',
    'finance_source_alias','finance_payment_ownership'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_insert_scope ON iron_gate.%I FOR INSERT TO iron_gate_runtime WITH CHECK (property_id::text = current_setting(''iron_gate.property_id'', true) AND iron_gate.finance_write_scope_allowed(property_id))', t);
    EXECUTE format('GRANT INSERT ON iron_gate.%I TO iron_gate_runtime', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS finance_document_update_scope ON iron_gate.finance_document;
CREATE POLICY finance_document_update_scope ON iron_gate.finance_document
  FOR UPDATE TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
GRANT UPDATE (current_version, status, updated_at)
  ON iron_gate.finance_document TO iron_gate_runtime;
COMMIT;
