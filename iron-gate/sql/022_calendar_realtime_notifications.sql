-- Calendar invalidations only. No booking or guest fields leave the outbox.
-- Topic capabilities are provisioned separately, never in source control.
-- This private schema is not a Data API schema and grants no Iron Gate access.
DO $calendar_realtime_preflight$
BEGIN
  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL OR
    to_regprocedure('realtime.topic()') IS NULL OR
    NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'realtime.messages'::regclass
      AND relrowsecurity) THEN
    RAISE EXCEPTION 'CALENDAR_REALTIME_PREREQUISITE_MISSING';
  END IF;
  -- Existing permissive policies could bypass capability isolation or allow
  -- forged invalidations. Require review rather than silently combining them.
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'realtime.messages'::regclass
    AND polname <> 'calendar_realtime_anon_receive'
    AND (0::oid = ANY(polroles) OR
      (SELECT oid FROM pg_roles WHERE rolname = 'anon') = ANY(polroles) OR
      (SELECT oid FROM pg_roles WHERE rolname = 'authenticated') = ANY(polroles))) THEN
    RAISE EXCEPTION 'CALENDAR_REALTIME_EXISTING_POLICY_REQUIRES_REVIEW';
  END IF;
END;
$calendar_realtime_preflight$;

CREATE SCHEMA IF NOT EXISTS calendar_realtime;
REVOKE ALL ON SCHEMA calendar_realtime FROM PUBLIC;
GRANT USAGE ON SCHEMA calendar_realtime TO anon;

CREATE TABLE IF NOT EXISTS calendar_realtime.topics (
  property_id uuid PRIMARY KEY REFERENCES iron_gate.property_state(property_id),
  topic text NOT NULL UNIQUE CHECK (topic ~ '^calendar:[0-9a-f]{64}$'),
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE calendar_realtime.topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_realtime.topics FORCE ROW LEVEL SECURITY;
REVOKE ALL ON calendar_realtime.topics FROM PUBLIC, anon, authenticated, iron_gate_runtime;

CREATE OR REPLACE FUNCTION calendar_realtime.topic_allowed(candidate text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT candidate ~ '^calendar:[0-9a-f]{64}$' AND EXISTS (
    SELECT 1 FROM calendar_realtime.topics
    WHERE topic = candidate AND active
  )
$$;
REVOKE ALL ON FUNCTION calendar_realtime.topic_allowed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION calendar_realtime.topic_allowed(text) TO anon;

DROP POLICY IF EXISTS calendar_realtime_anon_receive ON realtime.messages;
CREATE POLICY calendar_realtime_anon_receive ON realtime.messages
  FOR SELECT TO anon
  USING (extension = 'broadcast' AND topic = (SELECT realtime.topic())
    AND (SELECT calendar_realtime.topic_allowed(realtime.topic())));
-- No INSERT policy: capability holders may receive but cannot broadcast.

CREATE OR REPLACE FUNCTION calendar_realtime.broadcast_outbox_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  destination text;
BEGIN
  IF TG_TABLE_SCHEMA <> 'iron_gate' OR TG_TABLE_NAME <> 'outbox' OR TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'CALENDAR_REALTIME_TRIGGER_SCOPE_INVALID';
  END IF;
  SELECT topic INTO destination FROM calendar_realtime.topics
    WHERE property_id = NEW.property_id AND active;
  IF destination IS NOT NULL THEN
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('property_id', NEW.property_id::text, 'cursor', NEW.cursor::text),
        'calendar.changed', destination, true
      );
    EXCEPTION WHEN OTHERS THEN
      -- Reconciliation remains the fallback. Never log topics, data or SQLERRM,
      -- and never turn a notification outage into a failed booking commit.
      RAISE WARNING 'CALENDAR_REALTIME_SEND_UNAVAILABLE';
    END;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION calendar_realtime.broadcast_outbox_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS calendar_realtime_outbox_insert ON iron_gate.outbox;
CREATE TRIGGER calendar_realtime_outbox_insert AFTER INSERT ON iron_gate.outbox
  FOR EACH ROW EXECUTE FUNCTION calendar_realtime.broadcast_outbox_change();
