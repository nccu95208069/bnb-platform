-- Keep an attested source actor separate from the credential that imported it.
-- The importer remains finance_revision.actor_ref and finance_event.actor_ref.
BEGIN;
ALTER TABLE iron_gate.finance_revision
  ADD COLUMN IF NOT EXISTS source_actor_ref text;
ALTER TABLE iron_gate.finance_revision
  DROP CONSTRAINT IF EXISTS finance_revision_source_actor_ref_safe;
ALTER TABLE iron_gate.finance_revision
  ADD CONSTRAINT finance_revision_source_actor_ref_safe
  CHECK (source_actor_ref IS NULL OR source_actor_ref ~ '^[A-Za-z0-9._:-]{1,128}$');
COMMIT;
