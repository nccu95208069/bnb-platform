-- Additive finance ledger foundation. No existing finance writer uses these tables.
-- Apply only after 001-004; do not backfill or enable finance commands in this migration.
BEGIN;
CREATE TABLE IF NOT EXISTS iron_gate.finance_connector (
  source_instance_id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_system text NOT NULL CHECK (source_system IN (
    'iron_gate_native', 'os_manual', 'os_legacy_payment', 'line_finance',
    'sweetfun_card', 'sheet_bulk', 'ota_evidence')),
  source_account_ref text,
  credential_ref text,
  enabled boolean NOT NULL DEFAULT false,
  cutover_at timestamptz,
  scan_cadence text,
  confirm_policy text NOT NULL DEFAULT 'manual' CHECK (confirm_policy IN ('manual', 'automatic')),
  watermark text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, source_instance_id),
  UNIQUE (property_id, source_instance_id, source_system),
  CHECK (source_account_ref IS NULL OR length(source_account_ref) <= 128),
  CHECK (credential_ref IS NULL OR length(credential_ref) <= 128)
);
CREATE INDEX IF NOT EXISTS finance_connector_property ON iron_gate.finance_connector(property_id, source_system);

CREATE TABLE IF NOT EXISTS iron_gate.finance_document (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  source_system text NOT NULL,
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  kind text NOT NULL CHECK (kind IN ('money', 'observation', 'card_result')),
  current_version integer NOT NULL CHECK (current_version > 0),
  status text NOT NULL CHECK (status IN ('active', 'void')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  UNIQUE (property_id, source_instance_id, source_record_id),
  FOREIGN KEY (property_id, source_instance_id, source_system)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id, source_system)
);
CREATE INDEX IF NOT EXISTS finance_document_property_source ON iron_gate.finance_document(property_id, source_system, created_at);

CREATE TABLE IF NOT EXISTS iron_gate.finance_revision (
  property_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('create', 'amend', 'void', 'card_fail')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 128),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version),
  UNIQUE (property_id, document_id, version),
  UNIQUE (document_id, source_version),
  FOREIGN KEY (property_id, document_id) REFERENCES iron_gate.finance_document(property_id, id)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_event (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  document_id uuid NOT NULL,
  revision_version integer NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'property_receipt', 'property_refund', 'ota_guest_payment_observed',
    'ota_payout', 'expense_paid', 'processor_fee_paid', 'reversal')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  cash_effect_cents bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'TWD' CHECK (currency = 'TWD'),
  effective_on date NOT NULL,
  cash_on date,
  service_on date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  category_code text,
  receipt_purpose text,
  payment_method_code text,
  payment_account_ref text,
  advanced_by_ref text,
  safe_description text CHECK (safe_description IS NULL OR length(safe_description) <= 500),
  evidence_level text NOT NULL CHECK (evidence_level IN (
    'operator_attested', 'provider_notice', 'processor_confirmed', 'bank_reconciled')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(evidence_ref) <= 256),
  reverses_event_id uuid,
  related_receipt_document_id uuid,
  related_receipt_event_id uuid,
  actor_ref text NOT NULL CHECK (length(actor_ref) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, id),
  FOREIGN KEY (property_id, document_id, revision_version)
    REFERENCES iron_gate.finance_revision(property_id, document_id, version),
  FOREIGN KEY (property_id, reverses_event_id)
    REFERENCES iron_gate.finance_event(property_id, id),
  FOREIGN KEY (property_id, related_receipt_document_id)
    REFERENCES iron_gate.finance_document(property_id, id),
  FOREIGN KEY (property_id, related_receipt_event_id)
    REFERENCES iron_gate.finance_event(property_id, id),
  CHECK ((reverses_event_id IS NULL) = (event_kind <> 'reversal')),
  CHECK ((event_kind = 'property_refund') = (related_receipt_document_id IS NOT NULL)),
  CHECK (related_receipt_event_id IS NULL OR related_receipt_document_id IS NOT NULL),
  CHECK (cash_effect_cents = CASE event_kind
    WHEN 'property_receipt' THEN amount_cents
    WHEN 'ota_payout' THEN amount_cents
    WHEN 'property_refund' THEN -amount_cents
    WHEN 'expense_paid' THEN -amount_cents
    WHEN 'processor_fee_paid' THEN -amount_cents
    WHEN 'ota_guest_payment_observed' THEN 0
    ELSE cash_effect_cents END),
  CHECK (cash_effect_cents = 0 OR cash_on IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_event_one_reversal ON iron_gate.finance_event(reverses_event_id)
  WHERE reverses_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_event_property_effective ON iron_gate.finance_event(property_id, effective_on, id);
CREATE INDEX IF NOT EXISTS finance_event_property_cash ON iron_gate.finance_event(property_id, cash_on, id);
CREATE INDEX IF NOT EXISTS finance_event_document_version ON iron_gate.finance_event(property_id, document_id, revision_version);

CREATE TABLE IF NOT EXISTS iron_gate.finance_allocation (
  property_id uuid NOT NULL,
  event_id uuid NOT NULL,
  booking_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  allocation_kind text NOT NULL CHECK (allocation_kind IN ('room', 'deposit', 'extra', 'ota_payout', 'expense')),
  PRIMARY KEY (event_id, booking_id, allocation_kind),
  FOREIGN KEY (property_id, event_id) REFERENCES iron_gate.finance_event(property_id, id)
);
CREATE INDEX IF NOT EXISTS finance_allocation_booking ON iron_gate.finance_allocation(property_id, booking_id, event_id);

CREATE TABLE IF NOT EXISTS iron_gate.finance_expense_attribution (
  property_id uuid NOT NULL,
  event_id uuid NOT NULL,
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  allocation_policy text NOT NULL CHECK (allocation_policy IN (
    'line_v1_last_month_whole_twd', 'os_source_exact', 'ig_v1_earliest_cent')),
  PRIMARY KEY (event_id, month),
  FOREIGN KEY (property_id, event_id) REFERENCES iron_gate.finance_event(property_id, id)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_request_receipt (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('accepted', 'review_required', 'rejected')),
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, source_instance_id, request_key),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_outbox (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_kind text NOT NULL CHECK (source_kind IN (
    'event', 'operational_status', 'recurring_rule', 'payout_rule',
    'evidence_assertion', 'settlement')),
  source_id uuid NOT NULL,
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 64),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'leased', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  UNIQUE (property_id, source_kind, source_id, destination)
);
CREATE INDEX IF NOT EXISTS finance_outbox_due ON iron_gate.finance_outbox(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS iron_gate.finance_source_link (
  property_id uuid NOT NULL,
  source_instance_id uuid NOT NULL,
  source_order_key text NOT NULL CHECK (length(source_order_key) BETWEEN 1 AND 256),
  booking_id uuid NOT NULL,
  verified_booking_version bigint NOT NULL CHECK (verified_booking_version > 0),
  source_snapshot_hash text NOT NULL CHECK (source_snapshot_hash ~ '^[0-9a-f]{64}$'),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, source_instance_id, source_order_key),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id)
);
CREATE INDEX IF NOT EXISTS finance_source_link_booking ON iron_gate.finance_source_link(property_id, booking_id);

CREATE TABLE IF NOT EXISTS iron_gate.finance_source_alias (
  property_id uuid NOT NULL,
  source_instance_id uuid NOT NULL,
  source_record_id text NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND 256),
  canonical_document_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 256),
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, source_instance_id, source_record_id),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id),
  FOREIGN KEY (property_id, canonical_document_id)
    REFERENCES iron_gate.finance_document(property_id, id)
);

CREATE TABLE IF NOT EXISTS iron_gate.finance_payment_ownership (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  provider_code text NOT NULL CHECK (length(provider_code) BETWEEN 1 AND 64),
  source_account_ref text CHECK (source_account_ref IS NULL OR length(source_account_ref) BETWEEN 1 AND 128),
  provider_transaction_ref text,
  booking_id uuid NOT NULL,
  existing_payment_event_id uuid,
  canonical_document_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (property_id, canonical_document_id)
    REFERENCES iron_gate.finance_document(property_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_transaction_unique
  ON iron_gate.finance_payment_ownership(provider_code, coalesce(source_account_ref, ''), provider_transaction_ref)
  WHERE provider_transaction_ref IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS finance_payment_existing_event_unique
  ON iron_gate.finance_payment_ownership(property_id, existing_payment_event_id)
  WHERE existing_payment_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finance_payment_booking ON iron_gate.finance_payment_ownership(property_id, booking_id);

CREATE TABLE IF NOT EXISTS iron_gate.finance_import_issue (
  id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  source_instance_id uuid NOT NULL,
  source_record_id text NOT NULL,
  source_version text NOT NULL,
  canonical_document_id uuid,
  reason_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('blocking', 'classification_only')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, source_instance_id, source_record_id, source_version, reason_code),
  FOREIGN KEY (property_id, source_instance_id)
    REFERENCES iron_gate.finance_connector(property_id, source_instance_id),
  FOREIGN KEY (property_id, canonical_document_id)
    REFERENCES iron_gate.finance_document(property_id, id)
);

-- A reversal restates the original period exactly. A refund is a new cash event
-- and must identify an original receipt in the same property and document.
CREATE OR REPLACE FUNCTION iron_gate.finance_validate_event_reference()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE original iron_gate.finance_event%ROWTYPE;
BEGIN
  IF NEW.event_kind = 'reversal' THEN
    SELECT * INTO original FROM iron_gate.finance_event
      WHERE property_id = NEW.property_id AND id = NEW.reverses_event_id;
    IF NOT FOUND OR original.event_kind = 'reversal'
       OR NEW.amount_cents <> original.amount_cents
       OR NEW.cash_effect_cents <> -original.cash_effect_cents
       OR NEW.effective_on <> original.effective_on
       OR NEW.cash_on IS DISTINCT FROM original.cash_on
       OR NEW.service_on IS DISTINCT FROM original.service_on THEN
      RAISE EXCEPTION 'FINANCE_REVERSAL_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_kind = 'property_refund' THEN
    IF NEW.related_receipt_event_id IS NULL THEN
      RAISE EXCEPTION 'FINANCE_REFUND_SOURCE_REQUIRED' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO original FROM iron_gate.finance_event
      WHERE property_id = NEW.property_id AND id = NEW.related_receipt_event_id;
    IF NOT FOUND OR original.event_kind <> 'property_receipt'
       OR original.document_id <> NEW.related_receipt_document_id THEN
      RAISE EXCEPTION 'FINANCE_REFUND_SOURCE_MISMATCH' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION iron_gate.finance_validate_event_reference() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS finance_event_reference_guard ON iron_gate.finance_event;
CREATE TRIGGER finance_event_reference_guard BEFORE INSERT ON iron_gate.finance_event
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_validate_event_reference();

CREATE OR REPLACE FUNCTION iron_gate.finance_immutable_row()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'FINANCE_IMMUTABLE_ROW' USING ERRCODE = '23514';
END $$;
REVOKE ALL ON FUNCTION iron_gate.finance_immutable_row() FROM PUBLIC, anon, authenticated;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_revision','finance_event','finance_allocation','finance_expense_attribution',
    'finance_request_receipt','finance_source_link','finance_source_alias',
    'finance_payment_ownership'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.%I', t);
    EXECUTE format('CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE ON iron_gate.%I FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_immutable_row()', t);
  END LOOP;
END $$;

-- The finance API is not enabled yet. Runtime may inspect only its scoped rows;
-- DML grants are introduced together with the W2 transactional writer.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_connector','finance_document','finance_revision','finance_event',
    'finance_allocation','finance_expense_attribution','finance_request_receipt',
    'finance_outbox','finance_source_link','finance_source_alias',
    'finance_payment_ownership','finance_import_issue'] LOOP
    EXECUTE format('ALTER TABLE iron_gate.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE iron_gate.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS finance_property_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_property_scope ON iron_gate.%I FOR SELECT TO iron_gate_runtime USING (property_id::text = current_setting(''iron_gate.property_id'', true))', t);
    EXECUTE format('REVOKE ALL ON iron_gate.%I FROM PUBLIC, anon, authenticated, iron_gate_runtime', t);
    EXECUTE format('GRANT SELECT ON iron_gate.%I TO iron_gate_runtime', t);
  END LOOP;
END $$;
COMMIT;
