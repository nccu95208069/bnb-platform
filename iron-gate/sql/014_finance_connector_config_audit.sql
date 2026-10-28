-- W5: per-property connector metadata and append-only configuration history.
-- This migration does not provision credentials, enable connectors or cut over writers.
BEGIN;

ALTER TABLE iron_gate.finance_connector
  ADD COLUMN IF NOT EXISTS adapter_key text,
  ADD COLUMN IF NOT EXISTS source_sheet_ref text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_connector_adapter_key_format') THEN
    ALTER TABLE iron_gate.finance_connector ADD CONSTRAINT finance_connector_adapter_key_format
      CHECK (adapter_key IS NULL OR adapter_key ~ '^[a-z][a-z0-9_]{0,63}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='finance_connector_sheet_ref_format') THEN
    ALTER TABLE iron_gate.finance_connector ADD CONSTRAINT finance_connector_sheet_ref_format
      CHECK (source_sheet_ref IS NULL OR source_sheet_ref ~ '^[A-Za-z0-9_-]{10,128}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS iron_gate.finance_connector_config_history (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  changed_at timestamptz NOT NULL DEFAULT now(),
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 128),
  config_json jsonb NOT NULL,
  PRIMARY KEY (property_id, source_instance_id, version),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);

CREATE OR REPLACE FUNCTION iron_gate.finance_connector_history_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_CONNECTOR_HISTORY_IMMUTABLE';
END $$;
DROP TRIGGER IF EXISTS finance_connector_history_immutable_trigger
  ON iron_gate.finance_connector_config_history;
CREATE TRIGGER finance_connector_history_immutable_trigger
  BEFORE UPDATE OR DELETE ON iron_gate.finance_connector_config_history
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_connector_history_immutable();

CREATE OR REPLACE FUNCTION iron_gate.finance_connector_audit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actor text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at) THEN
    RAISE EXCEPTION 'FINANCE_CONNECTOR_VERSION_CONFLICT';
  END IF;
  actor := COALESCE(NULLIF(current_setting('iron_gate.actor_ref', true), ''), current_user);
  INSERT INTO iron_gate.finance_connector_config_history
    (property_id,source_instance_id,version,actor_ref,config_json)
  VALUES (NEW.property_id,NEW.source_instance_id,NEW.version,actor,
    jsonb_build_object('source_system',NEW.source_system,
      'source_account_ref',NEW.source_account_ref,
      'credential_ref',NEW.credential_ref,
      'adapter_key',NEW.adapter_key,'source_sheet_ref',NEW.source_sheet_ref,
      'scan_cadence',NEW.scan_cadence,'confirm_policy',NEW.confirm_policy,
      'watermark',NEW.watermark,'enabled',NEW.enabled,
      'cutover_at',NEW.cutover_at,'updated_at',NEW.updated_at));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS finance_connector_audit_trigger ON iron_gate.finance_connector;
CREATE TRIGGER finance_connector_audit_trigger
  AFTER INSERT OR UPDATE ON iron_gate.finance_connector
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_connector_audit();

-- Existing rows receive a current-state baseline; earlier versions cannot be inferred.
INSERT INTO iron_gate.finance_connector_config_history
  (property_id,source_instance_id,version,actor_ref,config_json)
SELECT c.property_id,c.source_instance_id,c.version,'migration:014',
  jsonb_build_object('source_system',c.source_system,
    'source_account_ref',c.source_account_ref,'credential_ref',c.credential_ref,
    'adapter_key',c.adapter_key,'source_sheet_ref',c.source_sheet_ref,
    'scan_cadence',c.scan_cadence,'confirm_policy',c.confirm_policy,
    'watermark',c.watermark,'enabled',c.enabled,
    'cutover_at',c.cutover_at,'updated_at',c.updated_at)
FROM iron_gate.finance_connector c
ON CONFLICT (property_id,source_instance_id,version) DO NOTHING;

ALTER TABLE iron_gate.finance_connector_config_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.finance_connector_config_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_connector_history_property_read ON iron_gate.finance_connector_config_history;
CREATE POLICY finance_connector_history_property_read
  ON iron_gate.finance_connector_config_history FOR SELECT TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true));
REVOKE ALL ON iron_gate.finance_connector_config_history
  FROM PUBLIC, anon, authenticated, iron_gate_runtime;
GRANT SELECT ON iron_gate.finance_connector_config_history TO iron_gate_runtime;

COMMIT;
