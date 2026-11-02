-- Production operational grant adjustment for the 2026-10-22 Sweetfun calendar.
-- The token and proof secret are unchanged. This adds one status-only field to
-- the exact active OS calendar credential after the service is deployed.
-- Re-running after success is harmless; an unexpected credential state fails.
DO $grant$
DECLARE
  matched integer;
  current_fields jsonb;
BEGIN
  SELECT grant_json->'fields' INTO current_fields
  FROM iron_gate.credentials
  WHERE credential_id = '48c51f52-f4b5-4d0d-a85f-7375715e548a'
    AND property_id = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16'
    AND active AND expires_at > now()
    AND grant_json->>'origin' = 'os'
    AND grant_json->'actions' = '["booking:read","occupancy:aggregate"]'::jsonb;
  GET DIAGNOSTICS matched = ROW_COUNT;
  IF matched <> 1 OR (current_fields IS DISTINCT FROM '["guest_name"]'::jsonb
    AND current_fields IS DISTINCT FROM '["guest_name","payment_status"]'::jsonb) THEN
    RAISE EXCEPTION 'SWEETFUN_CALENDAR_CREDENTIAL_UNEXPECTED';
  END IF;
  UPDATE iron_gate.credentials
  SET grant_json = jsonb_set(grant_json, '{fields}',
    '["guest_name","payment_status"]'::jsonb, false)
  WHERE credential_id = '48c51f52-f4b5-4d0d-a85f-7375715e548a'
    AND property_id = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16';
END $grant$;

-- Readback (aggregate only):
-- SELECT credential_id, grant_json->'fields' AS fields, active, expires_at
-- FROM iron_gate.credentials
-- WHERE credential_id = '48c51f52-f4b5-4d0d-a85f-7375715e548a';
