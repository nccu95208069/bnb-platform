-- Restore room prices to existing OS members whose workspace role permits prices.
-- The OS bearer still requires a current, signed member proof on every request.
-- This updates exactly the existing Sweetfun calendar reader; a second OS grant
-- with guest_name only remains unchanged. Safe to rerun.
DO $$
DECLARE updated_count integer;
BEGIN
  UPDATE iron_gate.credentials
     SET grant_json = jsonb_set(grant_json, '{fields}',
       '["guest_name","payment_status","money"]'::jsonb)
   WHERE property_id = '95ae9bd1-5e6d-4386-be5b-6af3c5668a16'::uuid
     AND active = true
     AND grant_json->>'origin' = 'os'
     AND grant_json->>'authorityEpoch' = '1'
     AND grant_json->'actions' = '["booking:read","occupancy:aggregate"]'::jsonb
     AND grant_json->'fields' IN (
       '["guest_name","payment_status"]'::jsonb,
       '["guest_name","payment_status","money"]'::jsonb);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one active Sweetfun OS calendar reader; found %', updated_count;
  END IF;
END $$;
