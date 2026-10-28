-- Every accepted finance mutation has one property-local, ordered change.
-- Old outbox rows remain readable; new writers attach their rows to a change.
BEGIN;
LOCK TABLE iron_gate.property_state IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS iron_gate.finance_change (
  property_id uuid NOT NULL REFERENCES iron_gate.property_state(property_id),
  change_seq bigint NOT NULL CHECK (change_seq > 0),
  source_kind text NOT NULL CHECK (source_kind IN (
    'document_revision', 'operational_status', 'recurring_rule', 'payout_rule',
    'evidence_assertion', 'settlement', 'source_link', 'import_issue',
    'payment_account', 'category')),
  source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 512),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 256),
  origin text NOT NULL DEFAULT 'writer' CHECK (origin IN ('writer', 'legacy_baseline')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (property_id, change_seq),
  UNIQUE (property_id, source_kind, source_id, source_version)
);
ALTER TABLE iron_gate.finance_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.finance_change FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_property_scope ON iron_gate.finance_change;
CREATE POLICY finance_property_scope ON iron_gate.finance_change FOR SELECT
  TO iron_gate_runtime USING (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.finance_change;
CREATE POLICY finance_insert_scope ON iron_gate.finance_change FOR INSERT
  TO iron_gate_runtime WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
REVOKE ALL ON iron_gate.finance_change FROM PUBLIC, anon, authenticated, iron_gate_runtime;
GRANT SELECT, INSERT ON iron_gate.finance_change TO iron_gate_runtime;
DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.finance_change;
CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE ON iron_gate.finance_change
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_immutable_row();

CREATE TABLE IF NOT EXISTS iron_gate.finance_change_event (
  property_id uuid NOT NULL,
  change_seq bigint NOT NULL,
  event_id uuid NOT NULL,
  PRIMARY KEY (property_id, event_id),
  FOREIGN KEY (property_id, change_seq)
    REFERENCES iron_gate.finance_change(property_id, change_seq),
  FOREIGN KEY (property_id, event_id)
    REFERENCES iron_gate.finance_event(property_id, id)
);
CREATE INDEX IF NOT EXISTS finance_change_event_sequence
  ON iron_gate.finance_change_event(property_id, change_seq, event_id);
ALTER TABLE iron_gate.finance_change_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE iron_gate.finance_change_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS finance_property_scope ON iron_gate.finance_change_event;
CREATE POLICY finance_property_scope ON iron_gate.finance_change_event FOR SELECT
  TO iron_gate_runtime USING (property_id::text = current_setting('iron_gate.property_id', true));
DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.finance_change_event;
CREATE POLICY finance_insert_scope ON iron_gate.finance_change_event FOR INSERT
  TO iron_gate_runtime WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
REVOKE ALL ON iron_gate.finance_change_event FROM PUBLIC, anon, authenticated, iron_gate_runtime;
GRANT SELECT, INSERT ON iron_gate.finance_change_event TO iron_gate_runtime;
DROP TRIGGER IF EXISTS finance_immutable ON iron_gate.finance_change_event;
CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE ON iron_gate.finance_change_event
  FOR EACH ROW EXECUTE FUNCTION iron_gate.finance_immutable_row();

ALTER TABLE iron_gate.finance_outbox ADD COLUMN IF NOT EXISTS change_seq bigint;
-- The original UUID column could only identify event rows. A change also
-- covers source links, account codes and platform rules with text identities.
ALTER TABLE iron_gate.finance_outbox
  ALTER COLUMN source_id TYPE text USING source_id::text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'finance_outbox_change_fk'
    AND conrelid = 'iron_gate.finance_outbox'::regclass) THEN
    ALTER TABLE iron_gate.finance_outbox ADD CONSTRAINT finance_outbox_change_fk
      FOREIGN KEY (property_id, change_seq)
      REFERENCES iron_gate.finance_change(property_id, change_seq);
  END IF;
END $$;
-- PostgreSQL truncates the generated name of this four-column constraint.
DO $$ DECLARE old_name name; BEGIN
  SELECT conname INTO old_name FROM pg_constraint
    WHERE conrelid = 'iron_gate.finance_outbox'::regclass AND contype = 'u'
      AND pg_get_constraintdef(oid) =
        'UNIQUE (property_id, source_kind, source_id, destination)';
  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE iron_gate.finance_outbox DROP CONSTRAINT %I', old_name);
  END IF;
END $$;
ALTER TABLE iron_gate.finance_outbox
  DROP CONSTRAINT IF EXISTS finance_outbox_source_kind_check;
ALTER TABLE iron_gate.finance_outbox ADD CONSTRAINT finance_outbox_source_kind_check
  CHECK (source_kind IN ('event', 'document_revision', 'operational_status',
    'recurring_rule', 'payout_rule', 'evidence_assertion', 'settlement',
    'source_link', 'import_issue', 'payment_account', 'category'));
ALTER TABLE iron_gate.finance_outbox
  DROP CONSTRAINT IF EXISTS finance_outbox_source_id_length_check;
ALTER TABLE iron_gate.finance_outbox ADD CONSTRAINT finance_outbox_source_id_length_check
  CHECK (length(source_id) BETWEEN 1 AND 512);
CREATE UNIQUE INDEX IF NOT EXISTS finance_outbox_change_destination_unique
  ON iron_gate.finance_outbox(property_id, change_seq, destination)
  WHERE change_seq IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS finance_outbox_legacy_source_unique
  ON iron_gate.finance_outbox(property_id, source_kind, source_id, destination)
  WHERE change_seq IS NULL;

-- The migration is the serialization boundary for existing shadow finance
-- rows. A revision is recoverable exactly; mutable plan/catalog rows only
-- expose their current state, so those rows are marked legacy_baseline.
CREATE TEMP TABLE finance_change_baseline ON COMMIT DROP AS
SELECT property_id,source_kind,source_id,source_version,recorded_at FROM (
  SELECT r.property_id,'document_revision'::text AS source_kind,
    r.document_id::text AS source_id,r.version::text AS source_version,
    r.created_at AS recorded_at
    FROM iron_gate.finance_revision r
  UNION ALL SELECT s.property_id,'operational_status',s.id::text,s.version::text,
    s.recorded_at FROM iron_gate.finance_operational_status s
  UNION ALL SELECT r.property_id,'recurring_rule',r.id::text,r.version::text,
    timestamptz '1970-01-01 00:00:00+00' FROM iron_gate.finance_recurring_rule r
  UNION ALL SELECT p.property_id,'payout_rule',p.platform,p.version::text,
    timestamptz '1970-01-01 00:00:00+00' FROM iron_gate.finance_payout_rule p
  UNION ALL SELECT a.property_id,'evidence_assertion',a.id::text,'1',a.recorded_at
    FROM iron_gate.finance_evidence_assertion a
  UNION ALL SELECT s.property_id,'settlement',s.id::text,'1',s.created_at
    FROM iron_gate.finance_settlement s
  UNION ALL SELECT l.property_id,'source_link',
    l.source_instance_id::text || ':' || l.source_order_key,'!legacy_baseline',l.verified_at
    FROM iron_gate.finance_source_link l
  UNION ALL SELECT i.property_id,'import_issue',i.id::text,'!legacy_baseline',i.created_at
    FROM iron_gate.finance_import_issue i
  UNION ALL SELECT a.property_id,'payment_account',a.code,a.version::text,
    timestamptz '1970-01-01 00:00:00+00' FROM iron_gate.finance_account a
  UNION ALL SELECT c.property_id,'category',c.kind || ':' || c.code,c.version::text,
    timestamptz '1970-01-01 00:00:00+00' FROM iron_gate.finance_category c
) existing;

INSERT INTO iron_gate.finance_change
  (property_id,change_seq,source_kind,source_id,source_version,origin)
WITH pending AS (
  SELECT b.* FROM finance_change_baseline b
  WHERE NOT EXISTS (SELECT 1 FROM iron_gate.finance_change c
    WHERE c.property_id=b.property_id AND c.source_kind=b.source_kind
      AND c.source_id=b.source_id AND c.source_version=b.source_version)
    AND (b.source_kind NOT IN ('source_link','import_issue','payment_account','category')
      OR NOT EXISTS (SELECT 1 FROM iron_gate.finance_change c
        WHERE c.property_id=b.property_id AND c.source_kind=b.source_kind
          AND c.source_id=b.source_id))
), existing_max AS (
  SELECT property_id,MAX(change_seq) AS seq
  FROM iron_gate.finance_change GROUP BY property_id
)
SELECT p.property_id,COALESCE(m.seq,0) + row_number() OVER
    (PARTITION BY p.property_id ORDER BY p.recorded_at,p.source_kind,
      p.source_id,CASE WHEN p.source_kind IN ('document_revision',
        'operational_status','recurring_rule','payout_rule',
        'payment_account','category') THEN p.source_version::integer END,
      p.source_version),
  p.source_kind,p.source_id,p.source_version,'legacy_baseline'
FROM pending p LEFT JOIN existing_max m ON m.property_id=p.property_id
ON CONFLICT (property_id,source_kind,source_id,source_version) DO NOTHING;

INSERT INTO iron_gate.finance_change_event(property_id,change_seq,event_id)
SELECT e.property_id,c.change_seq,e.id
FROM iron_gate.finance_event e
JOIN iron_gate.finance_change c ON c.property_id=e.property_id
  AND c.source_kind='document_revision'
  AND c.source_id=e.document_id::text
  AND c.source_version=e.revision_version::text
ON CONFLICT (property_id,event_id) DO NOTHING;

-- Keep old per-event outbox rows as audit evidence. New consumers select
-- change_seq IS NOT NULL, and each baseline change receives one canonical row.
INSERT INTO iron_gate.finance_outbox
  (id,property_id,change_seq,source_kind,source_id,destination)
SELECT gen_random_uuid(),c.property_id,c.change_seq,c.source_kind,c.source_id,'sheet'
FROM iron_gate.finance_change c
WHERE c.origin='legacy_baseline'
ON CONFLICT DO NOTHING;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM iron_gate.finance_event e
    LEFT JOIN iron_gate.finance_change_event ce
      ON ce.property_id=e.property_id AND ce.event_id=e.id
    WHERE ce.event_id IS NULL) THEN
    RAISE EXCEPTION 'FINANCE_CHANGE_BACKFILL_INCOMPLETE';
  END IF;
END $$;

COMMIT;
