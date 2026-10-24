-- Prepared for the Sweetfun evidence shadow. Do not apply to production until
-- the target database backup and restore path has been verified.
-- The booking runtime and API roles receive no access to source payloads.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iron_gate_evidence_import') THEN
    CREATE ROLE iron_gate_evidence_import NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS iron_gate.migration_source_evidence (
  capture_id uuid NOT NULL,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_kind text NOT NULL CHECK (source_kind IN (
    'os_redis', 'line_firestore', 'sheet_finance_map', 'sheet_finance_projection')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_sha256 text NOT NULL CHECK (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  sheet_source_sha256 text NOT NULL CHECK (sheet_source_sha256 ~ '^[0-9a-f]{64}$'),
  source_copy_id text NOT NULL CHECK (length(source_copy_id) BETWEEN 1 AND 160),
  captured_at timestamptz NOT NULL,
  payload_text text NOT NULL CHECK (octet_length(payload_text) BETWEEN 2 AND 2000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (capture_id, source_kind)
);

ALTER TABLE iron_gate.migration_source_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.migration_source_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON iron_gate.migration_source_evidence FROM PUBLIC;
REVOKE ALL ON iron_gate.migration_source_evidence FROM iron_gate_runtime;
GRANT USAGE ON SCHEMA iron_gate TO iron_gate_evidence_import;
GRANT SELECT, INSERT ON iron_gate.migration_source_evidence TO iron_gate_evidence_import;
GRANT SELECT ON iron_gate.property_state TO iron_gate_evidence_import;

DROP POLICY IF EXISTS evidence_shadow_read ON iron_gate.property_state;
CREATE POLICY evidence_shadow_read ON iron_gate.property_state
  FOR SELECT TO iron_gate_evidence_import
  USING (property_id::text = current_setting('iron_gate.property_id', true));

DROP POLICY IF EXISTS evidence_capture_read ON iron_gate.migration_source_evidence;
CREATE POLICY evidence_capture_read ON iron_gate.migration_source_evidence
  FOR SELECT TO iron_gate_evidence_import
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND capture_id::text = current_setting('iron_gate.evidence_capture_id', true));
DROP POLICY IF EXISTS evidence_capture_insert ON iron_gate.migration_source_evidence;
CREATE POLICY evidence_capture_insert ON iron_gate.migration_source_evidence
  FOR INSERT TO iron_gate_evidence_import
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND capture_id::text = current_setting('iron_gate.evidence_capture_id', true));
