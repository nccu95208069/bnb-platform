# Iron Gate production role connection limit: 4 → 12

This is a production-only capacity contingency for Supabase project
`brcszrkwkgiwatrxevkf`, database `postgres`, login role
`iron_gate_prod_app`. The source-controlled migration is
[`sql/021_iron_gate_prod_app_connection_limit_12.sql`](sql/021_iron_gate_prod_app_connection_limit_12.sql).
It does not grant privileges, change credentials, alter the database-wide
connection limit, or touch data. Run it only after the bounded OS finance read
candidate is verified and the release operator approves this exact change.

## Preflight (read only)

Run against the named Supabase project and stop if any result differs. This
query does not expose credentials or guest data.

```sql
SELECT current_database() AS database_name, current_user AS executor,
  current_setting('max_connections')::integer AS max_connections,
  (SELECT count(*) FROM pg_stat_activity) AS total_sessions,
  (SELECT count(*) FROM pg_stat_activity
   WHERE usename = 'iron_gate_prod_app') AS iron_gate_sessions;

SELECT oid::text AS role_oid, rolname, rolconnlimit, rolcanlogin, rolinherit,
  rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls,
  rolvaliduntil IS NULL AS no_expiry
FROM pg_roles WHERE rolname = 'iron_gate_prod_app';

SELECT pg_get_userbyid(roleid) AS granted_role, admin_option,
  inherit_option, set_option
FROM pg_auth_members
WHERE member = (SELECT oid FROM pg_roles
                WHERE rolname = 'iron_gate_prod_app');
```

Expected on 2026-10-30 before applying: database and executor `postgres`,
`max_connections = 60`, exactly one role row with OID `17768`, limit `4`
(or `12` for an idempotent rerun), LOGIN and INHERIT true, all elevated
attributes false, no expiry. Exactly one direct membership is
`iron_gate_runtime` with admin false, inherit true, set true. At 11:20 Taipei
the database had 16 total sessions and one idle Iron Gate session; refresh
these counts immediately before applying. Stop if the role identity, grant,
database capacity, or overall connection headroom has changed.

## Apply and readback

Apply the exact SQL file as one `iron_gate_prod_app_connection_limit_12_20261030`
migration on project `brcszrkwkgiwatrxevkf`. Its single `DO` statement is
atomic: it accepts only the observed role identity and limit 4 or 12, changes
only `CONNECTION LIMIT`, and checks the new value before completing. Do not
substitute an unguarded `ALTER ROLE` or target another project.

Immediately repeat the preflight queries. Confirm the role limit is `12` and
every other role attribute and membership matches the preflight. Check the
Supavisor logs for new SQLSTATE `53300` and Vercel request logs for 5xx while
performing only authorized read checks: Iron Gate cron 200, booking list and
calendar snapshot 200, OS finance GET 200, and unauthorized finance GET 401.
Do not create a test financial transaction.

The role limit is a ceiling, not a reservation. A limit of 12 leaves room
under the database-wide 60 connection maximum at the observed baseline, but
it does not bound Vercel instance growth. Keep the OS read fanout capped and
monitor both role and total sessions after release.

If the readback fails, keep OS money writes paused and stop the LINE cutover.
For a deliberate rollback after confirming the same role identity and current
limit 12, use a separate reviewed migration containing only:

```sql
ALTER ROLE iron_gate_prod_app CONNECTION LIMIT 4;
```

After rollback, repeat the role and session readback. Lowering the limit does
not terminate sessions already open, so allow them to drain and watch for
new `53300` errors.
