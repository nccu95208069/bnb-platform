-- Additive non-money plans, classifications and settlement evidence.
-- No finance writer is enabled by this migration.
BEGIN;

CREATE TABLE IF NOT EXISTS iron_gate.finance_account (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('cash', 'bank', 'card', 'other')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (property_id, id),
  UNIQUE (property_id, code)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_category (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  kind text NOT NULL CHECK (kind IN ('income', 'expense')),
  code text NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 128),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (property_id, kind, code)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_recurring_rule (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  version integer NOT NULL CHECK (version > 0),
  cadence text NOT NULL CHECK (cadence IN ('weekly', 'monthly', 'yearly')),
  start_on date NOT NULL,
  end_on date,
  next_due_on date,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'ended')),
  category_kind text NOT NULL DEFAULT 'expense' CHECK (category_kind = 'expense'),
  category_code text NOT NULL,
  UNIQUE (property_id, source_instance_id, source_record_id),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id),
  FOREIGN KEY (property_id, category_kind, category_code)
    REFERENCES iron_gate.finance_category(property_id, kind, code)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_payout_rule (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  platform text NOT NULL CHECK (length(platform) BETWEEN 1 AND 64),
  mode text NOT NULL CHECK (mode IN ('fixed_day', 'offset_days', 'manual')),
  day integer CHECK (day BETWEEN 1 AND 31),
  offset_days integer CHECK (offset_days BETWEEN 0 AND 90),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  PRIMARY KEY (property_id, platform),
  CHECK ((mode = 'fixed_day' AND day IS NOT NULL AND offset_days IS NULL)
    OR (mode = 'offset_days' AND day IS NULL AND offset_days IS NOT NULL)
    OR (mode = 'manual' AND day IS NULL AND offset_days IS NULL))
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_operational_status (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  booking_id uuid,
  source_instance_id uuid NOT NULL,
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  version integer NOT NULL CHECK (version > 0),
  status_code text NOT NULL CHECK (length(status_code) BETWEEN 1 AND 64),
  settles_room boolean NOT NULL DEFAULT false,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, source_instance_id, source_record_id, version),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);
CREATE INDEX IF NOT EXISTS finance_status_booking ON iron_gate.finance_operational_status(property_id, booking_id, recorded_at);

CREATE TABLE IF NOT EXISTS iron_gate.finance_evidence_assertion (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  event_id uuid NOT NULL,
  evidence_level text NOT NULL CHECK (evidence_level IN ('provider_notice', 'processor_confirmed', 'bank_reconciled')),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  processor_transaction_ref text,
  settlement_batch_ref text,
  bank_on date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 128),
  UNIQUE (property_id, event_id, evidence_level, evidence_ref),
  FOREIGN KEY (property_id, event_id) REFERENCES iron_gate.finance_event(property_id, id)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_settlement (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  settlement_batch_ref text NOT NULL CHECK (length(settlement_batch_ref) BETWEEN 1 AND 256),
  processor_transaction_ref text,
  gross_cents bigint NOT NULL CHECK (gross_cents >= 0),
  refund_cents bigint NOT NULL CHECK (refund_cents >= 0),
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  net_cents bigint NOT NULL CHECK (net_cents >= 0),
  bank_on date,
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  UNIQUE (property_id, source_instance_id, settlement_batch_ref),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id),
  CHECK (gross_cents - refund_cents - fee_cents = net_cents)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_settlement_link (
  settlement_id uuid NOT NULL,
  property_id uuid NOT NULL,
  event_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('gross', 'refund', 'fee')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  PRIMARY KEY (settlement_id, event_id, role),
  FOREIGN KEY (property_id, settlement_id)
    REFERENCES iron_gate.finance_settlement(property_id, id),
  FOREIGN KEY (property_id, event_id)
    REFERENCES iron_gate.finance_event(property_id, id)
);
CREATE INDEX IF NOT EXISTS finance_settlement_link_event ON iron_gate.finance_settlement_link(property_id, event_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_account','finance_category','finance_recurring_rule','finance_payout_rule',
    'finance_operational_status','finance_evidence_assertion','finance_settlement',
    'finance_settlement_link'] LOOP
    EXECUTE format('ALTER TABLE iron_gate.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE iron_gate.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS finance_property_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_property_scope ON iron_gate.%I FOR SELECT TO iron_gate_runtime USING (property_id::text = current_setting(''iron_gate.property_id'', true))', t);
    EXECUTE format('REVOKE ALL ON iron_gate.%I FROM PUBLIC, anon, authenticated, iron_gate_runtime', t);
    EXECUTE format('GRANT SELECT ON iron_gate.%I TO iron_gate_runtime', t);
  END LOOP;
END $$;
COMMIT;
