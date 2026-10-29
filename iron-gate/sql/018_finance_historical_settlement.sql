-- Private pre-cutover disposition for four reviewed legacy OS bookings.
-- This records no cash event and does not enable a writer or connector.
BEGIN;

CREATE TABLE IF NOT EXISTS iron_gate.finance_legacy_settlement (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  booking_version bigint NOT NULL CHECK (booking_version > 0),
  booking_snapshot_hash text NOT NULL CHECK (booking_snapshot_hash ~ '^[0-9a-f]{64}$'),
  booking_total_cents bigint NOT NULL CHECK (booking_total_cents > 0),
  source_order_key text NOT NULL CHECK (length(source_order_key) BETWEEN 1 AND 256),
  source_link_snapshot_hash text NOT NULL CHECK (source_link_snapshot_hash ~ '^[0-9a-f]{64}$'),
  os_receipt_id text NOT NULL CHECK (length(os_receipt_id) BETWEEN 1 AND 256),
  os_receipt_version text NOT NULL CHECK (length(os_receipt_version) BETWEEN 1 AND 128),
  os_receipt_snapshot_hash text NOT NULL CHECK (os_receipt_snapshot_hash ~ '^[0-9a-f]{64}$'),
  os_receipt_amount_cents bigint NOT NULL CHECK (os_receipt_amount_cents = 0),
  os_settles_room boolean NOT NULL CHECK (os_settles_room = true),
  full_os_snapshot_hash text NOT NULL CHECK (full_os_snapshot_hash ~ '^[0-9a-f]{64}$'),
  owner_decision_hash text NOT NULL CHECK (owner_decision_hash ~ '^[0-9a-f]{64}$'),
  sheet_snapshot_hash text NOT NULL CHECK (sheet_snapshot_hash ~ '^[0-9a-f]{64}$'),
  sheet_row_snapshot_hash text NOT NULL CHECK (sheet_row_snapshot_hash ~ '^[0-9a-f]{64}$'),
  sheet_order_source_version text NOT NULL CHECK (sheet_order_source_version ~ '^[0-9a-f]{64}$'),
  money_aliases_hash text NOT NULL CHECK (money_aliases_hash ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  decision text NOT NULL CHECK (decision IN
    ('settled_before_cutover_cash_details_unknown','unpaid_at_cutover')),
  cash_effect_cents bigint NOT NULL DEFAULT 0 CHECK (cash_effect_cents = 0),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  reviewed_by_ref text NOT NULL CHECK (length(reviewed_by_ref) BETWEEN 1 AND 128),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, booking_id),
  UNIQUE (property_id, source_instance_id, source_order_key),
  UNIQUE (property_id, source_instance_id, os_receipt_id, os_receipt_version),
  UNIQUE (property_id, source_instance_id, request_key),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);
CREATE INDEX IF NOT EXISTS finance_legacy_settlement_source
  ON iron_gate.finance_legacy_settlement(property_id, source_instance_id, id);
ALTER TABLE iron_gate.finance_legacy_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.finance_legacy_settlement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_legacy_settlement_scope ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_legacy_settlement_scope ON iron_gate.finance_legacy_settlement
  FOR SELECT TO iron_gate_runtime USING
    (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS finance_legacy_settlement_insert_scope ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_legacy_settlement_insert_scope
  ON iron_gate.finance_legacy_settlement
  FOR INSERT TO iron_gate_runtime WITH CHECK
    (property_id::text = current_setting('iron_gate.property_id', true)
      AND iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_write_scope_insert ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_write_scope_insert ON iron_gate.finance_legacy_settlement
  AS RESTRICTIVE FOR INSERT TO iron_gate_runtime
  WITH CHECK (iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_write_scope_update ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_write_scope_update ON iron_gate.finance_legacy_settlement
  AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime
  USING (iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (iron_gate.finance_write_scope_allowed(property_id));
DROP POLICY IF EXISTS finance_general_mode_insert ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_general_mode_insert ON iron_gate.finance_legacy_settlement
  AS RESTRICTIVE FOR INSERT TO iron_gate_runtime
  WITH CHECK (iron_gate.finance_write_scope_mode(property_id)='full');
DROP POLICY IF EXISTS finance_general_mode_update ON iron_gate.finance_legacy_settlement;
CREATE POLICY finance_general_mode_update ON iron_gate.finance_legacy_settlement
  AS RESTRICTIVE FOR UPDATE TO iron_gate_runtime
  USING (iron_gate.finance_write_scope_mode(property_id)='full')
  WITH CHECK (iron_gate.finance_write_scope_mode(property_id)='full');
REVOKE ALL ON iron_gate.finance_legacy_settlement
  FROM PUBLIC, anon, authenticated, iron_gate_runtime;
GRANT SELECT, INSERT ON iron_gate.finance_legacy_settlement TO iron_gate_runtime;
DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.finance_legacy_settlement;
CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE
  ON iron_gate.finance_legacy_settlement FOR EACH ROW
  EXECUTE FUNCTION iron_gate.finance_immutable_row();

ALTER TABLE iron_gate.finance_change DROP CONSTRAINT IF EXISTS finance_change_source_kind_check;
ALTER TABLE iron_gate.finance_change ADD CONSTRAINT finance_change_source_kind_check
  CHECK (source_kind IN ('document_revision', 'operational_status', 'recurring_rule',
    'payout_rule', 'evidence_assertion', 'settlement', 'source_link', 'import_issue',
    'payment_account', 'category', 'legacy_settlement'));

COMMIT;
