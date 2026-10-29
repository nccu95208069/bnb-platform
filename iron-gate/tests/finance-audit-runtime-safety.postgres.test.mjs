import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { assertRuntimeDatabase } from '../src/runtime-safety.mjs';
import { FinanceCommandService } from '../src/finance-commands.mjs';

const enabled = process.env.IRON_GATE_FINANCE_AUDIT_TEST_DATABASE === 'iron_gate_audit_test';
const config = { host: '/private/tmp', port: Number(process.env.IRON_GATE_FINANCE_AUDIT_TEST_PORT ?? 55442),
  database: 'iron_gate_audit_test' };

test('finance activity never requires direct runtime audit_log SELECT',
  { skip: !enabled }, async () => {
    const admin = new Pool(config);
    const runtime = new Pool(config);
    const workspaceId = randomUUID();
    const propertyId = randomUUID();
    const otherPropertyId = randomUUID();
    const unadmittedPropertyId = randomUUID();
    const connectorId = randomUUID();
    const auditId = randomUUID();
    const otherAuditId = randomUUID();
    const unadmittedAuditId = randomUUID();
    try {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      // Reproduce migration 013's unsafe grant on this disposable database.
      await admin.query('GRANT SELECT ON iron_gate.audit_log TO iron_gate_runtime');
      const guarded = await runtime.connect();
      try {
        await guarded.query('SET ROLE iron_gate_runtime');
        await assert.rejects(assertRuntimeDatabase(guarded), /UNSAFE_DATABASE_ROLE_OR_SCHEMA/);
      } finally { guarded.release(); }

      await admin.query(await readFile(new URL('../sql/019_finance_audit_read_emergency_revoke.sql',
        import.meta.url), 'utf8'));
      const safeReadMigration = await readFile(new URL('../sql/020_finance_activity_safe_read.sql',
        import.meta.url), 'utf8');
      await admin.query(safeReadMigration);
      // A replay of migration 013 must not reopen direct audit-table access.
      await admin.query('GRANT SELECT ON iron_gate.audit_log TO iron_gate_runtime');
      await admin.query(`CREATE POLICY audit_finance_read_scope ON iron_gate.audit_log
        FOR SELECT TO iron_gate_runtime USING (true)`);
      await admin.query(safeReadMigration);
      const safe = await runtime.connect();
      try {
        await safe.query('SET ROLE iron_gate_runtime');
        await assertRuntimeDatabase(safe);
        await assert.rejects(safe.query('SELECT audit_id FROM iron_gate.audit_log'),
          error => error.code === '42501');
      } finally { safe.release(); }
      const stalePolicy = await admin.query(`SELECT 1 FROM pg_policies
        WHERE schemaname='iron_gate' AND tablename='audit_log'
          AND policyname='audit_finance_read_scope'`);
      assert.equal(stalePolicy.rowCount,0);
      const acl = await admin.query(`SELECT
        has_function_privilege('iron_gate_runtime',
          'iron_gate.finance_activity_operations(uuid)','EXECUTE') AS runtime_execute,
        has_function_privilege('anon',
          'iron_gate.finance_activity_operations(uuid)','EXECUTE') AS anon_execute,
        has_function_privilege('authenticated',
          'iron_gate.finance_activity_operations(uuid)','EXECUTE') AS authenticated_execute`);
      assert.deepEqual(acl.rows[0],{runtime_execute:true,anon_execute:false,
        authenticated_execute:false});

      for (const id of [propertyId, otherPropertyId, unadmittedPropertyId]) {
        await admin.query(`INSERT INTO iron_gate.property_state
          (property_id,workspace_id,authority_epoch,inventory_version,state_json)
          VALUES ($1,$2,1,1,$3::jsonb)`, [id,workspaceId,
          JSON.stringify({propertyId:id,workspaceId,authorityEpoch:1,version:1,
            roomIds:[],readOnly:false,bookings:[]})]);
      }
      // Two admitted properties prove the GUC check works independently of scope.
      for (const id of [propertyId, otherPropertyId]) {
        await admin.query(`INSERT INTO iron_gate.finance_write_scope(property_id,mode)
          VALUES ($1,'general_only')`,[id]);
      }
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$2,'os_manual',true,now()-interval '1 day')`,
      [connectorId,propertyId]);
      for (const [id,property] of [[auditId,propertyId],
        [otherAuditId,otherPropertyId],[unadmittedAuditId,unadmittedPropertyId]]) {
        await admin.query(`INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)
          VALUES ($1,$2,$3::jsonb)`,[id,property,JSON.stringify({auditId:id,
          propertyId:property,type:'finance.operation',action:'finance:status',
          actorRef:'synthetic-operator',requestKey:`synthetic-${id}`,
          operationKind:'calendar_payment_confirmed',sourceInstanceId:connectorId})]);
      }
      const principal = {origin:'os',workspaceId,propertyIds:[propertyId],
        authorityEpoch:1,subjectId:'synthetic-operator',
        financeSourceInstanceId:connectorId,actions:['finance:read']};
      const service = new FinanceCommandService({connect:async () => {
        const client = await runtime.connect();
        await client.query('SET ROLE iron_gate_runtime');
        return client;
      }},'synthetic-preview-secret-at-least-32-characters',true);
      const activity = await service.activity(principal,propertyId);
      assert.equal(activity.total,1);
      assert.equal(activity.activities[0].id,auditId);
      assert.equal(activity.activities[0].ui_action,'calendar_payment_confirmed');
      const cross = await runtime.connect();
      try {
        await cross.query('BEGIN');
        await cross.query('SET LOCAL ROLE iron_gate_runtime');
        await cross.query("SELECT set_config('iron_gate.property_id',$1,true)",[propertyId]);
        const rows = await cross.query('SELECT audit_id FROM iron_gate.finance_activity_operations($1)',
          [otherPropertyId]);
        assert.equal(rows.rowCount,0);
        await cross.query("SELECT set_config('iron_gate.property_id',$1,true)",[otherPropertyId]);
        const admitted = await cross.query(
          'SELECT audit_id FROM iron_gate.finance_activity_operations($1)',[otherPropertyId]);
        assert.equal(admitted.rowCount,1);
        assert.equal(admitted.rows[0].audit_id,otherAuditId);
        await cross.query("SELECT set_config('iron_gate.property_id',$1,true)",[unadmittedPropertyId]);
        const unadmitted = await cross.query(
          'SELECT audit_id FROM iron_gate.finance_activity_operations($1)',[unadmittedPropertyId]);
        assert.equal(unadmitted.rowCount,0);
      } finally { await cross.query('ROLLBACK').catch(() => {}); cross.release(); }
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE').catch(() => {});
      await runtime.end(); await admin.end();
    }
  });
