-- Run on the original and isolated restored Supabase projects. Compare each
-- category's count and digest. This covers the dedicated iron_gate tables,
-- columns, constraints, indexes, policies, functions, and iron_gate_* roles;
-- it does not audit Supabase-managed schemas or Storage objects.
WITH objects AS (
  SELECT 'tables' AS category, c.relname || ':' || c.relkind::text || ':' ||
    c.relrowsecurity::text || ':' || c.relforcerowsecurity::text AS signature
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'iron_gate' AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'columns', c.relname || ':' || a.attnum::text || ':' || a.attname || ':' ||
    format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' ||
    coalesce(pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'iron_gate' AND c.relkind IN ('r', 'p') AND
    a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraints', c.relname || ':' || con.conname || ':' ||
    pg_get_constraintdef(con.oid)
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'iron_gate'
  UNION ALL
  SELECT 'indexes', indexname || ':' || indexdef
  FROM pg_indexes WHERE schemaname = 'iron_gate'
  UNION ALL
  SELECT 'policies', tablename || ':' || policyname || ':' || cmd || ':' ||
    coalesce(roles::text, '') || ':' || coalesce(qual, '') || ':' ||
    coalesce(with_check, '')
  FROM pg_policies WHERE schemaname = 'iron_gate'
  UNION ALL
  SELECT 'functions', p.proname || ':' ||
    pg_get_function_identity_arguments(p.oid) || ':' || pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'iron_gate'
  UNION ALL
  SELECT 'roles', rolname || ':' || rolcanlogin::text || ':' ||
    rolinherit::text || ':' || rolcreaterole::text || ':' ||
    rolcreatedb::text || ':' || rolreplication::text
  FROM pg_roles WHERE rolname LIKE 'iron_gate_%'
)
SELECT category, count(*) AS item_count,
  md5(coalesce(string_agg(signature, E'\n' ORDER BY signature), '')) AS digest
FROM objects GROUP BY category ORDER BY category;
