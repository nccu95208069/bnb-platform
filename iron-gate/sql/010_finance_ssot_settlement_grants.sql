-- W2: append-only evidence and settlement links; settlement is not income.
BEGIN;
ALTER TABLE iron_gate.finance_evidence_assertion
  DROP CONSTRAINT IF EXISTS finance_bank_assertion_date;
ALTER TABLE iron_gate.finance_evidence_assertion
  ADD CONSTRAINT finance_bank_assertion_date
  CHECK (evidence_level <> 'bank_reconciled' OR bank_on IS NOT NULL);
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_evidence_assertion','finance_settlement','finance_settlement_link'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_insert_scope ON iron_gate.%I FOR INSERT TO iron_gate_runtime WITH CHECK (property_id::text = current_setting(''iron_gate.property_id'', true))', t);
    EXECUTE format('GRANT INSERT ON iron_gate.%I TO iron_gate_runtime', t);
    EXECUTE format('DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.%I', t);
    EXECUTE format('CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE ON iron_gate.%I FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_immutable_row()', t);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION iron_gate.finance_assert_settlement_links()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target iron_gate.finance_settlement%ROWTYPE;
  gross bigint; refund bigint; fee bigint;
BEGIN
  IF TG_TABLE_NAME = 'finance_settlement' THEN
    target := NEW;
  ELSE
    SELECT * INTO target FROM iron_gate.finance_settlement
      WHERE property_id = NEW.property_id AND id = NEW.settlement_id;
  END IF;
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE role='gross'),0),
         COALESCE(sum(amount_cents) FILTER (WHERE role='refund'),0),
         COALESCE(sum(amount_cents) FILTER (WHERE role='fee'),0)
    INTO gross,refund,fee FROM iron_gate.finance_settlement_link
    WHERE property_id=target.property_id AND settlement_id=target.id;
  IF gross<>target.gross_cents OR refund<>target.refund_cents OR fee<>target.fee_cents THEN
    RAISE EXCEPTION 'FINANCE_SETTLEMENT_LINK_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.finance_settlement_link l
    JOIN iron_gate.finance_event e ON e.property_id=l.property_id AND e.id=l.event_id
    WHERE l.property_id=target.property_id AND l.settlement_id=target.id
      AND ((l.role='gross' AND e.event_kind NOT IN ('property_receipt','ota_payout'))
        OR (l.role='refund' AND e.event_kind<>'property_refund')
        OR (l.role='fee' AND e.event_kind<>'processor_fee_paid'))) THEN
    RAISE EXCEPTION 'FINANCE_SETTLEMENT_KIND_MISMATCH' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION iron_gate.finance_assert_settlement_links() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS finance_settlement_balanced ON iron_gate.finance_settlement;
CREATE CONSTRAINT TRIGGER finance_settlement_balanced
  AFTER INSERT ON iron_gate.finance_settlement DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_assert_settlement_links();
DROP TRIGGER IF EXISTS finance_settlement_link_balanced ON iron_gate.finance_settlement_link;
CREATE CONSTRAINT TRIGGER finance_settlement_link_balanced
  AFTER INSERT ON iron_gate.finance_settlement_link DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_assert_settlement_links();
COMMIT;
