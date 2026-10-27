-- Cross-row finance invariants are checked at COMMIT so one atomic command can
-- insert its event and all allocations in any order. No writer is enabled here.
BEGIN;

ALTER TABLE iron_gate.finance_event ADD COLUMN IF NOT EXISTS category_kind text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_event_category_pair') THEN
    ALTER TABLE iron_gate.finance_event ADD CONSTRAINT finance_event_category_pair
      CHECK ((category_kind IS NULL AND category_code IS NULL)
        OR (category_kind IN ('income', 'expense') AND category_code IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_event_category_scope') THEN
    ALTER TABLE iron_gate.finance_event ADD CONSTRAINT finance_event_category_scope
      FOREIGN KEY (property_id, category_kind, category_code)
      REFERENCES iron_gate.finance_category(property_id, kind, code);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION iron_gate.finance_assert_event_balances()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  e iron_gate.finance_event%ROWTYPE;
  original iron_gate.finance_event%ROWTYPE;
  allocated bigint;
  attributed bigint;
  expected bigint;
BEGIN
  IF TG_TABLE_NAME = 'finance_event' THEN
    e := NEW;
  ELSE
    SELECT * INTO e FROM iron_gate.finance_event
      WHERE property_id = NEW.property_id AND id = NEW.event_id;
  END IF;
  IF e.id IS NULL THEN RAISE EXCEPTION 'FINANCE_EVENT_MISSING' USING ERRCODE = '23503'; END IF;
  SELECT COALESCE(sum(amount_cents), 0) INTO allocated FROM iron_gate.finance_allocation
    WHERE property_id = e.property_id AND event_id = e.id;
  SELECT COALESCE(sum(amount_cents), 0) INTO attributed FROM iron_gate.finance_expense_attribution
    WHERE property_id = e.property_id AND event_id = e.id;

  IF e.event_kind = 'reversal' THEN
    SELECT * INTO original FROM iron_gate.finance_event
      WHERE property_id = e.property_id AND id = e.reverses_event_id;
    SELECT COALESCE(sum(amount_cents), 0) INTO expected FROM iron_gate.finance_allocation
      WHERE property_id = e.property_id AND event_id = original.id;
    IF allocated <> -expected THEN
      RAISE EXCEPTION 'FINANCE_REVERSAL_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(sum(amount_cents), 0) INTO expected FROM iron_gate.finance_expense_attribution
      WHERE property_id = e.property_id AND event_id = original.id;
    IF attributed <> -expected THEN
      RAISE EXCEPTION 'FINANCE_REVERSAL_ATTRIBUTION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM iron_gate.finance_allocation a
      FULL JOIN iron_gate.finance_allocation r
        ON r.property_id = e.property_id AND r.event_id = e.id
       AND a.booking_id = r.booking_id AND a.allocation_kind = r.allocation_kind
      WHERE a.property_id = e.property_id AND a.event_id = original.id
        AND (r.event_id IS NULL OR a.amount_cents <> -r.amount_cents)
    ) OR EXISTS (
      SELECT 1 FROM iron_gate.finance_allocation r
      WHERE r.property_id = e.property_id AND r.event_id = e.id
        AND NOT EXISTS (SELECT 1 FROM iron_gate.finance_allocation a
          WHERE a.property_id = e.property_id AND a.event_id = original.id
            AND a.booking_id = r.booking_id AND a.allocation_kind = r.allocation_kind)
    ) THEN
      RAISE EXCEPTION 'FINANCE_REVERSAL_ALLOCATION_TARGET_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM iron_gate.finance_expense_attribution a
      WHERE a.property_id = e.property_id AND a.event_id = original.id
        AND NOT EXISTS (SELECT 1 FROM iron_gate.finance_expense_attribution r
          WHERE r.property_id = e.property_id AND r.event_id = e.id
            AND r.month = a.month AND r.amount_cents = -a.amount_cents)
    ) OR EXISTS (
      SELECT 1 FROM iron_gate.finance_expense_attribution r
      WHERE r.property_id = e.property_id AND r.event_id = e.id
        AND NOT EXISTS (SELECT 1 FROM iron_gate.finance_expense_attribution a
          WHERE a.property_id = e.property_id AND a.event_id = original.id
            AND a.month = r.month)
    ) THEN
      RAISE EXCEPTION 'FINANCE_REVERSAL_MONTH_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM iron_gate.finance_allocation
        WHERE property_id = e.property_id AND event_id = e.id AND amount_cents <= 0)
       OR EXISTS (SELECT 1 FROM iron_gate.finance_expense_attribution
        WHERE property_id = e.property_id AND event_id = e.id AND amount_cents <= 0) THEN
      RAISE EXCEPTION 'FINANCE_ALLOCATION_SIGN_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF e.event_kind IN ('property_refund', 'ota_payout', 'ota_guest_payment_observed')
       OR (e.event_kind = 'property_receipt' AND e.receipt_purpose IN ('room','deposit','extra')) THEN
      IF allocated <> e.amount_cents THEN
        RAISE EXCEPTION 'FINANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
      END IF;
    ELSIF allocated <> 0 AND allocated <> e.amount_cents THEN
      RAISE EXCEPTION 'FINANCE_ALLOCATION_MISMATCH' USING ERRCODE = '23514';
    END IF;
    IF e.event_kind IN ('expense_paid', 'processor_fee_paid') THEN
      IF attributed <> e.amount_cents THEN
        RAISE EXCEPTION 'FINANCE_ATTRIBUTION_MISMATCH' USING ERRCODE = '23514';
      END IF;
    ELSIF attributed <> 0 THEN
      RAISE EXCEPTION 'FINANCE_UNEXPECTED_ATTRIBUTION' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION iron_gate.finance_assert_event_balances() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS finance_event_balances ON iron_gate.finance_event;
CREATE CONSTRAINT TRIGGER finance_event_balances
  AFTER INSERT ON iron_gate.finance_event DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_assert_event_balances();
DROP TRIGGER IF EXISTS finance_allocation_balances ON iron_gate.finance_allocation;
CREATE CONSTRAINT TRIGGER finance_allocation_balances
  AFTER INSERT ON iron_gate.finance_allocation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_assert_event_balances();
DROP TRIGGER IF EXISTS finance_attribution_balances ON iron_gate.finance_expense_attribution;
CREATE CONSTRAINT TRIGGER finance_attribution_balances
  AFTER INSERT ON iron_gate.finance_expense_attribution DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_assert_event_balances();

COMMIT;
