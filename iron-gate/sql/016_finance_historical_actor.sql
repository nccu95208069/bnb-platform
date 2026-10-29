-- Keep attested source identity and time separate from the importer's identity
-- and write time. created_at / recorded_at continue to mean import time.
BEGIN;
ALTER TABLE iron_gate.finance_revision
  ADD COLUMN IF NOT EXISTS source_actor_ref text,
  ADD COLUMN IF NOT EXISTS source_recorded_at timestamptz;
ALTER TABLE iron_gate.finance_revision
  DROP CONSTRAINT IF EXISTS finance_revision_source_actor_ref_safe;
ALTER TABLE iron_gate.finance_revision
  ADD CONSTRAINT finance_revision_source_actor_ref_safe
  CHECK (source_actor_ref IS NULL OR source_actor_ref ~ '^[A-Za-z0-9._:-]{1,128}$');
ALTER TABLE iron_gate.finance_event
  ADD COLUMN IF NOT EXISTS source_recorded_at timestamptz;
COMMIT;
