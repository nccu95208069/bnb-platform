-- Keep the property scope as a statement-level initplan, while retaining the
-- transaction-local iron_gate.property_id setting and the same RLS boundaries.
ALTER POLICY property_scope ON iron_gate.property_state
  USING (property_id::text = (SELECT current_setting('iron_gate.property_id', true)))
  WITH CHECK (property_id::text = (SELECT current_setting('iron_gate.property_id', true)));

ALTER POLICY occupancy_scope ON iron_gate.occupied_room_nights
  USING (property_id::text = (SELECT current_setting('iron_gate.property_id', true)))
  WITH CHECK (property_id::text = (SELECT current_setting('iron_gate.property_id', true)));

ALTER POLICY outbox_scope ON iron_gate.outbox
  USING (property_id::text = (SELECT current_setting('iron_gate.property_id', true)))
  WITH CHECK (property_id::text = (SELECT current_setting('iron_gate.property_id', true)));

ALTER POLICY audit_append ON iron_gate.audit_log
  WITH CHECK (property_id::text = (SELECT current_setting('iron_gate.property_id', true)));

CREATE INDEX IF NOT EXISTS credentials_property_id ON iron_gate.credentials(property_id);
