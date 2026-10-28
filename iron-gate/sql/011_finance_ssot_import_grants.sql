-- W2 shadow import: reviewed source-order links are append-only and property scoped.
-- This does not enable a connector or move its cutover watermark.
BEGIN;
DROP POLICY IF EXISTS finance_source_link_insert_scope ON iron_gate.finance_source_link;
CREATE POLICY finance_source_link_insert_scope ON iron_gate.finance_source_link
  FOR INSERT TO iron_gate_runtime
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
GRANT INSERT ON iron_gate.finance_source_link TO iron_gate_runtime;
ALTER TABLE iron_gate.finance_import_issue
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolution_ref text,
  ADD COLUMN IF NOT EXISTS resolved_by_ref text;
ALTER TABLE iron_gate.finance_import_issue
  DROP CONSTRAINT IF EXISTS finance_import_issue_resolution_check;
ALTER TABLE iron_gate.finance_import_issue
  ADD CONSTRAINT finance_import_issue_resolution_check CHECK (
    (status = 'open' AND resolved_at IS NULL AND resolution_ref IS NULL AND resolved_by_ref IS NULL)
    OR (status = 'resolved' AND resolved_at IS NOT NULL AND
      length(resolution_ref) BETWEEN 1 AND 256 AND
      length(resolved_by_ref) BETWEEN 1 AND 128));
DROP POLICY IF EXISTS finance_import_issue_insert_scope ON iron_gate.finance_import_issue;
CREATE POLICY finance_import_issue_insert_scope ON iron_gate.finance_import_issue
  FOR INSERT TO iron_gate_runtime
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_import_issue_update_scope ON iron_gate.finance_import_issue;
CREATE POLICY finance_import_issue_update_scope ON iron_gate.finance_import_issue
  FOR UPDATE TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
GRANT INSERT ON iron_gate.finance_import_issue TO iron_gate_runtime;
GRANT UPDATE (status,resolved_at,resolution_ref,resolved_by_ref)
  ON iron_gate.finance_import_issue TO iron_gate_runtime;
COMMIT;
