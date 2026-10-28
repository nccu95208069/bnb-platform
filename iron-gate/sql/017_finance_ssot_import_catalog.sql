-- W7: retain exact source provenance for non-money shadow imports.
-- This migration does not enable a finance writer or a source cutover.
BEGIN;
ALTER TABLE iron_gate.finance_operational_status
  ADD COLUMN IF NOT EXISTS source_recorded_at timestamptz;
CREATE TABLE IF NOT EXISTS iron_gate.finance_import_catalog (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN
    ('operational_status','recurring_rule','payout_rule','account','category')),
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  source_version text NOT NULL CHECK (source_version ~ '^[A-Za-z0-9._:-]{1,128}$'),
  target_version integer NOT NULL CHECK (target_version > 0),
  target_ref text NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 256),
  source_snapshot_hash text NOT NULL CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  source_actor_ref text NOT NULL CHECK (source_actor_ref ~ '^os_actor:[0-9a-f]{64}$'),
  source_recorded_at timestamptz NOT NULL,
  imported_payload jsonb NOT NULL CHECK (jsonb_typeof(imported_payload) = 'object'),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, source_instance_id, record_kind, source_record_id, source_version),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);
CREATE INDEX IF NOT EXISTS finance_import_catalog_source
  ON iron_gate.finance_import_catalog(property_id, source_instance_id, id);
ALTER TABLE iron_gate.finance_import_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.finance_import_catalog FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_import_catalog_scope ON iron_gate.finance_import_catalog;
CREATE POLICY finance_import_catalog_scope ON iron_gate.finance_import_catalog
  FOR SELECT TO iron_gate_runtime USING
    (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS finance_import_catalog_insert_scope ON iron_gate.finance_import_catalog;
CREATE POLICY finance_import_catalog_insert_scope ON iron_gate.finance_import_catalog
  FOR INSERT TO iron_gate_runtime WITH CHECK
    (property_id::text = current_setting('iron_gate.property_id', true)
      AND iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_write_scope_insert ON iron_gate.finance_import_catalog;
CREATE POLICY finance_write_scope_insert ON iron_gate.finance_import_catalog
  AS RESTRICTIVE FOR INSERT TO iron_gate_runtime
  WITH CHECK (iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_write_scope_update ON iron_gate.finance_import_catalog;
CREATE POLICY finance_write_scope_update ON iron_gate.finance_import_catalog
  AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime
  USING (iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_general_mode_insert ON iron_gate.finance_import_catalog;
CREATE POLICY finance_general_mode_insert ON iron_gate.finance_import_catalog
  AS RESTRICTIVE FOR INSERT TO iron_gate_runtime
  WITH CHECK (iron_gate.finance_write_scope_mode(property_id)='full');
DROP POLICY IF EXISTS finance_general_mode_update ON iron_gate.finance_import_catalog;
CREATE POLICY finance_general_mode_update ON iron_gate.finance_import_catalog
  AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime
  USING (iron_gate.finance_write_scope_mode(property_id)='full')
  WITH CHECK (iron_gate.finance_write_scope_mode(property_id)='full');
REVOKE ALL ON iron_gate.finance_import_catalog FROM PUBLIC, anon, authenticated, iron_gate_runtime;
GRANT SELECT, INSERT ON iron_gate.finance_import_catalog TO iron_gate_runtime;
DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.finance_import_catalog;
CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE
  ON iron_gate.finance_import_catalog FOR EACH ROW
  EXECUTE FUNCTION iron_gate.finance_immutable_row();
COMMIT;
