-- Applied in production as finance_audit_read_emergency_revoke_019.
-- Migration 013 granted a privilege that the runtime startup guard forbids.
BEGIN;
REVOKE SELECT ON iron_gate.audit_log FROM iron_gate_runtime;
COMMIT;
