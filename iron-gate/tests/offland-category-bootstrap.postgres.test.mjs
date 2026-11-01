import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from
  '../../frontend/src/lib/finance-model.ts';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE ===
  'iron_gate_finance_test3';
const config = { host: '/private/tmp',
  port: Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database: 'iron_gate_finance_test3' };
const migration = await readFile(new URL(
  '../sql/022_offland_general_finance_categories.sql', import.meta.url), 'utf8');
const expected = [
  ...Object.entries(INCOME_CATEGORIES).filter(([code]) => code !== 'lodging')
    .map(([code,label]) => ({ kind:'income',code,label })),
  ...Object.entries(EXPENSE_CATEGORIES)
    .map(([code,label]) => ({ kind:'expense',code,label })),
].sort((a,b) => `${a.kind}:${a.code}`.localeCompare(`${b.kind}:${b.code}`));

function state(propertyId,workspaceId) {
  return { propertyId,workspaceId,authorityEpoch:1,version:1,readOnly:false,
    roomIds:[],bookings:[],channel:{mode:'none',ready:false,grantId:null} };
}
async function fixture(admin, actorRef = 'release:offland-general-finance',
  includeLine = true) {
  await admin.query('TRUNCATE iron_gate.property_state CASCADE');
  const propertyId=randomUUID(), otherPropertyId=randomUUID();
  const workspaceId=randomUUID(), otherWorkspaceId=randomUUID();
  for (const [p,w] of [[propertyId,workspaceId],
    [otherPropertyId,otherWorkspaceId]])
    await admin.query(`INSERT INTO iron_gate.property_state
      (property_id,workspace_id,authority_epoch,inventory_version,state_json)
      VALUES ($1,$2,1,1,$3::jsonb)`,[p,w,JSON.stringify(state(p,w))]);
  await admin.query(`INSERT INTO iron_gate.finance_write_scope
    (property_id,mode,actor_ref) VALUES ($1,'general_only',$2)`,
  [propertyId,actorRef]);
  const osId=randomUUID(), lineId=randomUUID();
  for (const [sourceId,sourceSystem] of [
    [osId,'os_manual'],...(includeLine ? [[lineId,'line_finance']] : [])])
    await admin.query(`INSERT INTO iron_gate.finance_connector
      (source_instance_id,property_id,source_system,source_account_ref,enabled,cutover_at)
      VALUES ($1,$2,$3,$4,true,now()-interval '1 day')`,
    [sourceId,propertyId,sourceSystem,`synthetic:${sourceSystem}`]);
  return {propertyId,otherPropertyId,workspaceId,osId,lineId};
}
function principal(origin,sourceId,{propertyId,workspaceId}) {
  return {origin,workspaceId,propertyIds:[propertyId],authorityEpoch:1,
    subjectId:'synthetic-operator',financeSourceInstanceId:sourceId,
    financeGeneralEntriesOnly:true,
    actions:['finance:read','finance:record_receipt','finance:record_expense']};
}
function command(id,kind,category) {
  return {request_key:`bootstrap-${id}`,source_record_id:id,source_version:'1',
    action:'create',event_kind:kind,amount_cents:500,currency:'TWD',
    effective_on:'2026-10-28',cash_on:'2026-10-28',
    category_code:category,evidence_level:'operator_attested',
    ...(kind === 'property_receipt' ? {receipt_purpose:'other'} :
      {expense_attributions:[{month:'2026-10-01',amount_cents:500,
        allocation_policy:'ig_v1_earliest_cent'}]})};
}

test('Offland category bootstrap is scoped, complete, idempotent and usable by both general sources',
  {skip:!enabled}, async () => {
    const admin=new Pool(config), runtime=new Pool(config);
    const service=new FinanceCommandService({connect:async () => {
      const client=await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    }},'synthetic-bootstrap-secret-32-bytes-long',true);
    try {
      const context=await fixture(admin);
      await admin.query(migration);
      const rows=(await admin.query(`SELECT kind,code,label
        FROM iron_gate.finance_category WHERE property_id=$1
        ORDER BY kind,code`,[context.propertyId])).rows;
      assert.deepEqual(rows,expected);
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.finance_category WHERE property_id=$1`,
      [context.otherPropertyId])).rows[0].n,0);
      for (const table of ['finance_change','finance_outbox']) {
        const result=await admin.query(`SELECT count(*)::int AS n
          FROM iron_gate.${table} WHERE property_id=$1`,
        [context.propertyId]);
        assert.equal(result.rows[0].n,0);
      }
      await admin.query(migration);
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.finance_category WHERE property_id=$1`,
      [context.propertyId])).rows[0].n,18);

      const os=principal('os',context.osId,context);
      const line=principal('line',context.lineId,context);
      const catalog=await service.categories(os,context.propertyId);
      assert.deepEqual(catalog.categories.map(({kind,code,label}) =>
        ({kind,code,label})),expected);
      assert.equal(catalog.as_of_change_seq,0);
      const income=command('os-breakfast','property_receipt','breakfast');
      const expense=command('line-supplies','expense_paid','supplies');
      assert.equal((await service.command(os,context.propertyId,income,
        income.request_key)).receipt_status,'accepted');
      assert.equal((await service.command(line,context.propertyId,expense,
        expense.request_key)).receipt_status,'accepted');
      const lodging=command('os-lodging','property_receipt','lodging');
      await assert.rejects(service.command(os,context.propertyId,lodging,
        lodging.request_key),error => error.code === 'INVALID_CATEGORY');
      const booking={...command('line-booking','property_receipt','breakfast'),
        receipt_purpose:'room',booking_allocations:[{booking_id:randomUUID(),
          expected_booking_version:1,allocation_kind:'room',amount_cents:500}]};
      await assert.rejects(service.command(line,context.propertyId,booking,
        booking.request_key),error => error.code === 'SOURCE_FORBIDDEN');
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.finance_event WHERE property_id=$1`,
      [context.propertyId])).rows[0].n,2);
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end();
      await admin.end();
    }
  });

test('Offland category bootstrap fails closed on changed release identity or connector',
  {skip:!enabled}, async () => {
    const admin=new Pool(config);
    try {
      const wrongActor=await fixture(admin,'unrelated-release');
      await assert.rejects(admin.query(migration));
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.finance_category WHERE property_id=$1`,
      [wrongActor.propertyId])).rows[0].n,0);
      const missingLine=await fixture(admin,undefined,false);
      await assert.rejects(admin.query(migration),
        error => /OFFLAND_CATEGORY_CONNECTOR_MISMATCH/.test(error.message));
      assert.equal((await admin.query(`SELECT count(*)::int AS n
        FROM iron_gate.finance_category WHERE property_id=$1`,
      [missingLine.propertyId])).rows[0].n,0);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,source_account_ref,enabled,cutover_at)
        VALUES ($1,$2,'os_manual','synthetic:duplicate-os',true,now()-interval '1 day')`,
      [randomUUID(),missingLine.propertyId]);
      await assert.rejects(admin.query(migration),
        error => /OFFLAND_CATEGORY_CONNECTOR_MISMATCH/.test(error.message));
      const conflict=await fixture(admin);
      await admin.query(`INSERT INTO iron_gate.finance_category
        (property_id,kind,code,label) VALUES ($1,'income','breakfast','Wrong label')`,
      [conflict.propertyId]);
      await assert.rejects(admin.query(migration),
        error => /OFFLAND_CATEGORY_CONFLICT/.test(error.message));
      assert.deepEqual((await admin.query(`SELECT kind,code,label
        FROM iron_gate.finance_category WHERE property_id=$1`,
      [conflict.propertyId])).rows,
      [{kind:'income',code:'breakfast',label:'Wrong label'}]);
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await admin.end();
    }
  });
