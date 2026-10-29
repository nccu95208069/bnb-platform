import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';
import { offlandGeneralFinanceGrantPackage } from
  '../scripts/prepare-offland-general-finance-grants.mjs';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE === 'iron_gate_finance_test3';
const poolConfig = { host: '/private/tmp',
  port: Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database: 'iron_gate_finance_test3' };

function command(record, kind, action = 'create', version = 1) {
  const common = { request_key: `${record}-${action}`, source_record_id: record,
    source_version: String(version), action,
    ...(version > 1 ? { expected_version: version - 1 } : {}) };
  if (action === 'void') return common;
  return { ...common, event_kind: kind, amount_cents: 500, currency: 'TWD',
    effective_on: '2026-10-28', cash_on: '2026-10-28',
    evidence_level: 'operator_attested',
    ...(kind === 'property_receipt' ? { receipt_purpose: 'other' } :
      { category_code: 'supplies', expense_attributions: [{ month: '2026-10-01',
        amount_cents: 500, allocation_policy: 'ig_v1_earliest_cent' }] }) };
}

test('Offland LINE general grant corrects only its own unallocated documents with no channel',
  { skip: !enabled }, async () => {
    const admin = new Pool(poolConfig);
    const runtime = new Pool(poolConfig);
    const propertyId = randomUUID(), workspaceId = randomUUID();
    const lineId = randomUUID(), osId = randomUUID(), legacyId = randomUUID();
    const bookingDocumentId = randomUUID(), bookingEventId = randomUUID();
    const candidate = { schema: 1, property_key: 'offland', property_id: propertyId,
      status: 'candidate_only_no_production_change', connectors: [
        ['line_finance',lineId],['os_manual',osId],['os_legacy_payment',legacyId],
      ].map(([source_system,source_instance_id]) => ({ source_system,source_instance_id,
        source_account_ref: `synthetic:${source_system}`, enabled: false, cutover_at: null })) };
    const grants = offlandGeneralFinanceGrantPackage(candidate,
      { project_ref: 'brcszrkwkgiwatrxevkf', property_id: propertyId,
        workspace_id: workspaceId, authority_epoch: 1, read_only: false },
      { existing_credential_id: randomUUID(),
        existing_property_id: '95ae9bd1-5e6d-4386-be5b-6af3c5668a16',
        existing_grant_id: randomUUID(), group_id: 'synthetic-group',
        actor_ids: ['synthetic-operator'] });
    const principal = name => {
      const grant = grants.items.find(item => item.name === name).grant;
      return { origin: grant.origin,workspaceId,propertyIds: [propertyId],
        authorityEpoch: 1,subjectId: 'synthetic-operator',actions: grant.actions,
        financeSourceInstanceId: grant.financeSourceInstanceId,
        financeGeneralEntriesOnly: grant.financeGeneralEntriesOnly };
    };
    const line = principal('line'), os = principal('os');
    const service = new FinanceCommandService({ connect: async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } }, 'synthetic-finance-test-secret-32-bytes-long', true);
    try {
      // Only a disposable opt-in database is ever cleared by this test.
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`,[propertyId,workspaceId,JSON.stringify({
        propertyId,workspaceId,authorityEpoch:1,version:1,readOnly:false,
        roomIds:[],bookings:[],channel:{mode:'none',ready:false,grantId:null} })]);
      await admin.query(`INSERT INTO iron_gate.finance_write_scope(property_id,mode)
        VALUES ($1,'general_only')`,[propertyId]);
      for (const [id,system] of [[lineId,'line_finance'],[osId,'os_manual']])
        await admin.query(`INSERT INTO iron_gate.finance_connector
          (source_instance_id,property_id,source_system,source_account_ref,enabled,cutover_at)
          VALUES ($1,$2,$3,$4,true,now()-interval '1 day')`,
        [id,propertyId,system,`synthetic:${system}`]);
      await admin.query(`INSERT INTO iron_gate.finance_category(property_id,kind,code,label)
        VALUES ($1,'expense','supplies','Supplies')`,[propertyId]);

      // An administrator can retain historical booking money under this source.
      // The restricted LINE credential must never amend or void that document.
      const imported = await admin.connect();
      try {
        await imported.query('BEGIN');
        await imported.query(`INSERT INTO iron_gate.finance_document
        (id,property_id,source_instance_id,source_system,source_record_id,
         kind,current_version,status)
        VALUES ($1,$2,$3,'line_finance','historical-room','money',1,'active')`,
        [bookingDocumentId,propertyId,lineId]);
        await imported.query(`INSERT INTO iron_gate.finance_revision
        (property_id,document_id,version,action,request_hash,source_version,actor_ref)
        VALUES ($1,$2,1,'create',$3,'1','admin-import')`,
        [propertyId,bookingDocumentId,'a'.repeat(64)]);
        await imported.query(`INSERT INTO iron_gate.finance_event
        (id,property_id,document_id,revision_version,event_kind,amount_cents,
         cash_effect_cents,effective_on,cash_on,receipt_purpose,evidence_level,actor_ref)
        VALUES ($1,$2,$3,1,'property_receipt',500,500,'2026-10-28',
          '2026-10-28','room','operator_attested','admin-import')`,
        [bookingEventId,propertyId,bookingDocumentId]);
        await imported.query(`INSERT INTO iron_gate.finance_allocation
        (property_id,event_id,booking_id,amount_cents,allocation_kind)
        VALUES ($1,$2,$3,500,'room')`,[propertyId,bookingEventId,randomUUID()]);
        await imported.query('COMMIT');
      } finally {
        await imported.query('ROLLBACK').catch(() => {});
        imported.release();
      }

      const income = command('line-income','property_receipt');
      const preview = await service.preview(line,propertyId,income,income.request_key);
      assert.deepEqual(preview.bookings,[]);
      assert.equal(preview.preview_token,null);
      assert.equal((await service.command(line,propertyId,income,income.request_key))
        .document_version,1);
      const amended = command('line-income','property_receipt','amend',2);
      assert.equal((await service.command(line,propertyId,amended,amended.request_key))
        .document_version,2);
      const expense = command('line-expense','expense_paid');
      assert.equal((await service.command(line,propertyId,expense,expense.request_key))
        .document_version,1);
      const voidExpense = command('line-expense','expense_paid','void',2);
      assert.equal((await service.command(line,propertyId,voidExpense,voidExpense.request_key))
        .document_version,2);
      const voidIncome = command('line-income','property_receipt','void',3);
      assert.equal((await service.command(line,propertyId,voidIncome,voidIncome.request_key))
        .document_version,3);

      const bookingCreate = { ...command('new-room','property_receipt'),
        receipt_purpose: 'room', booking_allocations: [{ booking_id: randomUUID(),
          expected_booking_version: 1, amount_cents: 500, allocation_kind: 'room' }] };
      const bookingAmend = { ...command('historical-room','property_receipt','amend',2),
        receipt_purpose: 'other' };
      const bookingVoid = command('historical-room','property_receipt','void',2);
      for (const input of [bookingCreate,bookingAmend,bookingVoid]) {
        await assert.rejects(service.preview(line,propertyId,input,input.request_key),
          error => error.code === 'SOURCE_FORBIDDEN');
        await assert.rejects(service.command(line,propertyId,input,input.request_key),
          error => error.code === 'SOURCE_FORBIDDEN');
      }
      const osIncome = command('os-income','property_receipt');
      const osReceipt = await service.command(os,propertyId,osIncome,osIncome.request_key);
      const crossSource = command('os-income','property_receipt','void',2);
      await assert.rejects(service.preview(line,propertyId,crossSource,
        crossSource.request_key),error => error.code === 'VERSION_CONFLICT');
      await assert.rejects(service.command(line,propertyId,crossSource,
        crossSource.request_key),error => error.code === 'VERSION_CONFLICT');
      const historical = await admin.query(`SELECT current_version,status FROM
        iron_gate.finance_document WHERE id=$1`,[bookingDocumentId]);
      assert.deepEqual(historical.rows[0],{current_version:1,status:'active'});
      const osDocument = await admin.query(`SELECT current_version,status FROM
        iron_gate.finance_document WHERE id=$1`,[osReceipt.document_id]);
      assert.deepEqual(osDocument.rows[0],{current_version:1,status:'active'});
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end();
      await admin.end();
    }
  });
