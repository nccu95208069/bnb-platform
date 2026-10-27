-- OS catalog and non-cash reminder metadata. Existing finance tables remain private.
BEGIN;
ALTER TABLE iron_gate.finance_account
  ADD COLUMN IF NOT EXISTS last_digits text;
ALTER TABLE iron_gate.finance_account
  DROP CONSTRAINT IF EXISTS finance_account_last_digits_check;
ALTER TABLE iron_gate.finance_account
  ADD CONSTRAINT finance_account_last_digits_check CHECK (
    last_digits IS NULL OR
    (kind = 'card' AND last_digits ~ '^[0-9]{4}$') OR
    (kind = 'bank' AND last_digits ~ '^[0-9]{5}$'));

ALTER TABLE iron_gate.finance_recurring_rule
  ADD COLUMN IF NOT EXISTS amount_cents bigint,
  ADD COLUMN IF NOT EXISTS safe_description text,
  ADD COLUMN IF NOT EXISTS payment_method_code text,
  ADD COLUMN IF NOT EXISTS due_day integer;
ALTER TABLE iron_gate.finance_recurring_rule
  DROP CONSTRAINT IF EXISTS finance_recurring_rule_os_fields_check;
ALTER TABLE iron_gate.finance_recurring_rule
  ADD CONSTRAINT finance_recurring_rule_os_fields_check CHECK (
    (amount_cents IS NULL OR amount_cents > 0) AND
    (safe_description IS NULL OR length(safe_description) <= 500) AND
    (payment_method_code IS NULL OR payment_method_code IN
      ('cash','bank_transfer','credit_card','other')) AND
    (due_day IS NULL OR due_day BETWEEN 1 AND 31));

ALTER TABLE iron_gate.finance_payout_rule
  ADD COLUMN IF NOT EXISTS offset_months integer;
ALTER TABLE iron_gate.finance_payout_rule
  DROP CONSTRAINT IF EXISTS finance_payout_rule_offset_months_check;
ALTER TABLE iron_gate.finance_payout_rule
  ADD CONSTRAINT finance_payout_rule_offset_months_check CHECK (
    offset_months IS NULL OR offset_months BETWEEN 1 AND 3);

ALTER TABLE iron_gate.finance_revision
  ADD COLUMN IF NOT EXISTS reason_note text;
ALTER TABLE iron_gate.finance_revision
  DROP CONSTRAINT IF EXISTS finance_revision_reason_note_check;
ALTER TABLE iron_gate.finance_revision
  ADD CONSTRAINT finance_revision_reason_note_check CHECK (
    reason_note IS NULL OR length(reason_note) BETWEEN 1 AND 300);

ALTER TABLE iron_gate.finance_event
  ADD COLUMN IF NOT EXISTS advanced_by_kind text,
  ADD COLUMN IF NOT EXISTS advanced_by_label text;
ALTER TABLE iron_gate.finance_event
  DROP CONSTRAINT IF EXISTS finance_event_advance_snapshot_check;
ALTER TABLE iron_gate.finance_event
  ADD CONSTRAINT finance_event_advance_snapshot_check CHECK (
    (advanced_by_ref IS NULL AND advanced_by_kind IS NULL AND advanced_by_label IS NULL)
    OR (advanced_by_ref IS NOT NULL AND advanced_by_kind IS NULL AND advanced_by_label IS NULL)
    OR (advanced_by_ref IS NOT NULL AND advanced_by_kind IN ('self','account','other')
      AND length(advanced_by_label) BETWEEN 1 AND 100));

DROP POLICY IF EXISTS finance_account_insert_scope ON iron_gate.finance_account;
CREATE POLICY finance_account_insert_scope ON iron_gate.finance_account
  FOR INSERT TO iron_gate_runtime
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
GRANT INSERT ON iron_gate.finance_account TO iron_gate_runtime;
DROP POLICY IF EXISTS finance_category_insert_scope ON iron_gate.finance_category;
CREATE POLICY finance_category_insert_scope ON iron_gate.finance_category
  FOR INSERT TO iron_gate_runtime
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
GRANT INSERT ON iron_gate.finance_category TO iron_gate_runtime;
GRANT UPDATE (amount_cents,safe_description,payment_method_code,due_day)
  ON iron_gate.finance_recurring_rule TO iron_gate_runtime;
GRANT UPDATE (offset_months)
  ON iron_gate.finance_payout_rule TO iron_gate_runtime;
COMMIT;
