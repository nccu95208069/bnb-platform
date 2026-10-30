-- Bootstrap the existing Offland general-finance UI catalog. Booking income
-- (lodging) remains outside the general-only grant and is deliberately absent.
-- The released Offland scope actor and live OS/LINE connectors identify the
-- sole target without embedding a private property UUID in source control.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE iron_gate.finance_write_scope, iron_gate.finance_connector
  IN SHARE MODE;

DO $offland_categories$
DECLARE
  target_property uuid;
  scope_count integer;
  connector_count integer;
  connector_system_count integer;
  item record;
  current_category record;
BEGIN
  SELECT count(*) INTO scope_count FROM iron_gate.finance_write_scope;
  IF scope_count <> 1 THEN
    RAISE EXCEPTION 'OFFLAND_CATEGORY_SCOPE_NOT_UNIQUE';
  END IF;
  SELECT property_id INTO target_property
    FROM iron_gate.finance_write_scope
    WHERE mode = 'general_only'
      AND actor_ref = 'release:offland-general-finance';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFLAND_CATEGORY_SCOPE_MISMATCH';
  END IF;

  -- Serialize with finance API writes on this property while checking the
  -- released scope and catalog. Catalog reads use finance_category directly.
  PERFORM 1 FROM iron_gate.property_state
    WHERE property_id = target_property
      AND state_json->>'readOnly' = 'false'
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFLAND_CATEGORY_AUTHORITY_CHANGED';
  END IF;
  SELECT count(*), count(DISTINCT source_system)
    INTO connector_count, connector_system_count
    FROM iron_gate.finance_connector
    WHERE property_id = target_property AND enabled
      AND cutover_at IS NOT NULL
      AND source_system IN ('os_manual', 'line_finance');
  IF connector_count <> 2 OR connector_system_count <> 2 OR EXISTS (
    SELECT 1 FROM iron_gate.finance_connector
    WHERE property_id = target_property AND enabled
      AND cutover_at IS NOT NULL
      AND source_system NOT IN ('os_manual', 'line_finance')) THEN
    RAISE EXCEPTION 'OFFLAND_CATEGORY_CONNECTOR_MISMATCH';
  END IF;

  FOR item IN SELECT kind, code, label FROM (VALUES
    ('income', 'breakfast', '早餐費'),
    ('income', 'overtime', '超時／延退費'),
    ('income', 'extra_guest', '加人／加床'),
    ('income', 'partner', '合作廠商收入'),
    ('income', 'other', '其他收入'),
    ('expense', 'laundry', '備品送洗'),
    ('expense', 'water', '水費'),
    ('expense', 'electricity', '電費'),
    ('expense', 'gas', '瓦斯費'),
    ('expense', 'utilities', '水電瓦斯（舊分類）'),
    ('expense', 'cable', '第四台'),
    ('expense', 'internet', '網路費'),
    ('expense', 'cleaning', '打掃清潔'),
    ('expense', 'supplies', '備品採購'),
    ('expense', 'repairs', '修繕維護'),
    ('expense', 'rent', '租金'),
    ('expense', 'small_items', '小物雜支'),
    ('expense', 'other', '其他花費')
  ) AS expected(kind, code, label)
  LOOP
    INSERT INTO iron_gate.finance_category
      (property_id, kind, code, label)
      VALUES (target_property, item.kind, item.code, item.label)
      ON CONFLICT (property_id, kind, code) DO NOTHING;
    SELECT label, status, version INTO STRICT current_category
      FROM iron_gate.finance_category
      WHERE property_id = target_property AND kind = item.kind
        AND code = item.code;
    IF current_category.label <> item.label OR
      current_category.status <> 'active' OR
      current_category.version <> 1 THEN
      RAISE EXCEPTION 'OFFLAND_CATEGORY_CONFLICT: %:%', item.kind, item.code;
    END IF;

  END LOOP;

  IF (SELECT count(*) FROM iron_gate.finance_category
      WHERE property_id = target_property AND code !~ '^custom_') <> 18 OR
    EXISTS (SELECT 1 FROM iron_gate.finance_category
      WHERE property_id = target_property AND kind = 'income'
        AND code = 'lodging') THEN
    RAISE EXCEPTION 'OFFLAND_CATEGORY_READBACK_MISMATCH';
  END IF;
END;
$offland_categories$;
COMMIT;
