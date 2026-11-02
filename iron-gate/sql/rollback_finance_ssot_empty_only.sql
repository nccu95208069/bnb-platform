-- Manual rollback for an unused W1-W7 schema installation only.
-- Never run after any new finance connector, SSOT credential, command,
-- backfill or cutover. Legacy card:sync / finance:ledger grants predate this schema.
-- The guard checks all known finance tables and audit records before dropping anything.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
-- Hold these locks through the guard and drops so a credential or finance row
-- cannot be inserted after the empty-state check.
LOCK TABLE iron_gate.credentials, iron_gate.audit_log IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  t text;
  n bigint;
  finance_tables text[] := ARRAY[
    'finance_connector','finance_document','finance_revision','finance_event',
    'finance_allocation','finance_expense_attribution','finance_request_receipt',
    'finance_outbox','finance_change_event','finance_change',
    'finance_source_link','finance_source_alias',
    'finance_payment_ownership','finance_import_issue','finance_import_catalog',
    'finance_account','finance_category','finance_recurring_rule',
    'finance_payout_rule','finance_operational_status','finance_evidence_assertion',
    'finance_settlement','finance_settlement_link',
    'finance_connector_config_history','finance_legacy_settlement',
    'finance_write_scope'];
BEGIN
  IF EXISTS (SELECT 1 FROM iron_gate.credentials c
    WHERE c.grant_json ? 'financeSourceInstanceId'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(c.grant_json->'actions') = 'array'
          THEN c.grant_json->'actions' ELSE '[]'::jsonb END) AS a(value)
        WHERE a.value LIKE 'finance:%' AND a.value <> 'finance:ledger')) THEN
    RAISE EXCEPTION 'FINANCE_ROLLBACK_CREDENTIAL_PRESENT';
  END IF;
  IF EXISTS (SELECT 1 FROM iron_gate.audit_log
    WHERE audit_json->>'type' = 'finance.operation') THEN
    RAISE EXCEPTION 'FINANCE_ROLLBACK_AUDIT_PRESENT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables
    WHERE schemaname = 'iron_gate' AND tablename LIKE 'finance_%'
      AND tablename <> ALL(finance_tables)) THEN
    RAISE EXCEPTION 'FINANCE_ROLLBACK_UNKNOWN_TABLE';
  END IF;
  FOREACH t IN ARRAY finance_tables LOOP
    IF to_regclass(format('iron_gate.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('LOCK TABLE iron_gate.%I IN ACCESS EXCLUSIVE MODE', t);
    EXECUTE format('SELECT count(*) FROM iron_gate.%I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FINANCE_ROLLBACK_NONEMPTY: %', t; END IF;
  END LOOP;
END $$;
DROP TABLE IF EXISTS iron_gate.finance_legacy_settlement;
DROP TABLE IF EXISTS iron_gate.finance_connector_config_history;
DROP TABLE IF EXISTS iron_gate.finance_settlement_link;
DROP TABLE IF EXISTS iron_gate.finance_settlement;
DROP TABLE IF EXISTS iron_gate.finance_evidence_assertion;
DROP TABLE IF EXISTS iron_gate.finance_operational_status;
DROP TABLE IF EXISTS iron_gate.finance_payout_rule;
DROP TABLE IF EXISTS iron_gate.finance_recurring_rule;
DROP TABLE IF EXISTS iron_gate.finance_account;
DROP TABLE IF EXISTS iron_gate.finance_import_issue;
DROP TABLE IF EXISTS iron_gate.finance_import_catalog;
DROP TABLE IF EXISTS iron_gate.finance_payment_ownership;
DROP TABLE IF EXISTS iron_gate.finance_source_alias;
DROP TABLE IF EXISTS iron_gate.finance_source_link;
DROP TABLE IF EXISTS iron_gate.finance_outbox;
DROP TABLE IF EXISTS iron_gate.finance_change_event;
DROP TABLE IF EXISTS iron_gate.finance_change;
DROP TABLE IF EXISTS iron_gate.finance_request_receipt;
DROP TABLE IF EXISTS iron_gate.finance_expense_attribution;
DROP TABLE IF EXISTS iron_gate.finance_allocation;
DROP TABLE IF EXISTS iron_gate.finance_event;
DROP TABLE IF EXISTS iron_gate.finance_category;
DROP TABLE IF EXISTS iron_gate.finance_revision;
DROP TABLE IF EXISTS iron_gate.finance_document;
DROP TABLE IF EXISTS iron_gate.finance_connector;
DROP FUNCTION IF EXISTS iron_gate.finance_general_attribution_allowed(uuid,uuid);
DROP FUNCTION IF EXISTS iron_gate.finance_general_event_allowed(uuid,uuid,text,text,uuid,text,text);
DROP FUNCTION IF EXISTS iron_gate.finance_general_document_allowed(uuid,uuid);
DROP FUNCTION IF EXISTS iron_gate.finance_general_connector_allowed(uuid,uuid);
DROP FUNCTION IF EXISTS iron_gate.finance_write_scope_allowed(uuid);
DROP FUNCTION IF EXISTS iron_gate.finance_write_scope_mode(uuid);
DROP TABLE IF EXISTS iron_gate.finance_write_scope;
DROP FUNCTION IF EXISTS iron_gate.finance_validate_event_reference();
DROP FUNCTION IF EXISTS iron_gate.finance_immutable_row();
DROP FUNCTION IF EXISTS iron_gate.finance_assert_event_balances();
DROP FUNCTION IF EXISTS iron_gate.finance_assert_settlement_links();
DROP FUNCTION IF EXISTS iron_gate.finance_connector_history_immutable();
DROP FUNCTION IF EXISTS iron_gate.finance_connector_audit();
DROP POLICY IF EXISTS audit_finance_read_scope ON iron_gate.audit_log;
REVOKE SELECT ON iron_gate.audit_log FROM iron_gate_runtime;
COMMIT;
