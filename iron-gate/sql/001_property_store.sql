-- Standalone PostgreSQL schema for an independent Iron Gate service.
-- Prepared and tested locally; this file has not been applied to any live DB.
CREATE SCHEMA IF NOT EXISTS iron_gate;
REVOKE ALL ON SCHEMA iron_gate FROM PUBLIC;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iron_gate_runtime') THEN
    CREATE ROLE iron_gate_runtime NOLOGIN;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS iron_gate.property_state (
  property_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  inventory_version bigint NOT NULL CHECK (inventory_version >= 0),
  state_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT state_identity_matches CHECK (
    state_json->>'propertyId' = property_id::text AND
    state_json->>'workspaceId' = workspace_id::text AND
    (state_json->>'authorityEpoch')::bigint = authority_epoch AND
    (state_json->>'version')::bigint = inventory_version
  )
);

CREATE TABLE IF NOT EXISTS iron_gate.occupied_room_nights (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  room_id uuid NOT NULL,
  night date NOT NULL,
  booking_id uuid NOT NULL,
  PRIMARY KEY (property_id, room_id, night)
);

CREATE TABLE IF NOT EXISTS iron_gate.outbox (
  cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_identity_matches CHECK (
    event_json->>'eventId' = event_id::text AND
    event_json->>'propertyId' = property_id::text
  )
);
CREATE INDEX IF NOT EXISTS outbox_property_cursor ON iron_gate.outbox(property_id, cursor);

ALTER TABLE iron_gate.property_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.property_state FORCE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.occupied_room_nights ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.occupied_room_nights FORCE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_scope ON iron_gate.property_state;
CREATE POLICY property_scope ON iron_gate.property_state
  FOR ALL TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS occupancy_scope ON iron_gate.occupied_room_nights;
CREATE POLICY occupancy_scope ON iron_gate.occupied_room_nights
  FOR ALL TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS outbox_scope ON iron_gate.outbox;
CREATE POLICY outbox_scope ON iron_gate.outbox
  FOR ALL TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));

GRANT USAGE ON SCHEMA iron_gate TO iron_gate_runtime;
GRANT SELECT, INSERT, UPDATE ON iron_gate.property_state TO iron_gate_runtime;
GRANT SELECT, INSERT, DELETE ON iron_gate.occupied_room_nights TO iron_gate_runtime;
GRANT SELECT, INSERT ON iron_gate.outbox TO iron_gate_runtime;
GRANT USAGE ON SEQUENCE iron_gate.outbox_cursor_seq TO iron_gate_runtime;

CREATE TABLE IF NOT EXISTS iron_gate.audit_log (
  audit_id uuid PRIMARY KEY,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  audit_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_identity_matches CHECK (
    audit_json->>'auditId' = audit_id::text AND
    audit_json->>'propertyId' = property_id::text
  )
);
CREATE INDEX IF NOT EXISTS audit_property_created ON iron_gate.audit_log(property_id, created_at);
ALTER TABLE iron_gate.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_append ON iron_gate.audit_log;
CREATE POLICY audit_append ON iron_gate.audit_log
  FOR INSERT TO iron_gate_runtime
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
GRANT INSERT ON iron_gate.audit_log TO iron_gate_runtime;

-- Runtime can verify an opaque token but cannot enumerate, issue, or revoke credentials.
-- Provisioning and revocation use the migration owner's separate administrative connection.
CREATE TABLE IF NOT EXISTS iron_gate.credentials (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  credential_id uuid NOT NULL UNIQUE,
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  grant_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CONSTRAINT credential_property_matches CHECK (grant_json->>'propertyId' = property_id::text),
  CONSTRAINT credential_id_matches CHECK (grant_json->>'credentialId' = credential_id::text)
);
REVOKE ALL ON iron_gate.credentials FROM PUBLIC;
REVOKE ALL ON iron_gate.credentials FROM iron_gate_runtime;

CREATE OR REPLACE FUNCTION iron_gate.lookup_credential(p_token_hash text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT grant_json FROM iron_gate.credentials
  WHERE token_hash = p_token_hash AND active = true AND expires_at > now()
$$;
REVOKE ALL ON FUNCTION iron_gate.lookup_credential(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION iron_gate.lookup_credential(text) TO iron_gate_runtime;
