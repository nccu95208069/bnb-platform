import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE ===
  'iron_gate_finance_test3';
const config = { host: '/private/tmp',
  port: Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database: 'iron_gate_finance_test3' };

async function denied(client, sql, params = [], rowSecurity = true) {
  await client.query('SAVEPOINT denied_write');
  await assert.rejects(client.query(sql, params), error =>
    error.code === '42501' && (!rowSecurity ||
      /row-level security policy/.test(error.message)));
  await client.query('ROLLBACK TO SAVEPOINT denied_write');
  await client.query('RELEASE SAVEPOINT denied_write');
}

test('general_only PostgreSQL scope admits general entries and denies other writes',
  { skip: !enabled }, async () => {
    const admin = new Pool(config);
    const runtime = new Pool(config);
    const workspaceId = randomUUID();
    const generalId = randomUUID();
    const otherScopedId = randomUUID();
    const unscopedId = randomUUID();
    const properties = [generalId,otherScopedId,unscopedId];
    const connectors = new Map(properties.map(id => [id,randomUUID()]));
    const expenseDocumentId = randomUUID();
    const receiptDocumentId = randomUUID();
    const importedBookingDocumentId = randomUUID();
    const expenseEventId = randomUUID();
    const receiptEventId = randomUUID();
    const importedBookingEventId = randomUUID();
    const documentInsert = `INSERT INTO iron_gate.finance_document
      (id,property_id,source_instance_id,source_system,source_record_id,
       kind,current_version,status)
      VALUES ($1,$2,$3,'os_manual',$4,'money',1,'active')`;
    const eventInsert = `INSERT INTO iron_gate.finance_event
      (id,property_id,document_id,revision_version,event_kind,
       amount_cents,cash_effect_cents,effective_on,cash_on,category_kind,
       category_code,receipt_purpose,related_receipt_document_id,
       related_receipt_event_id,evidence_level,actor_ref)
      VALUES ($1,$2,$3,1,$4,100,$5,'2026-10-28','2026-10-28',
        $6,$7,$8,$9,$10,'operator_attested','synthetic-operator')`;
    const event = (id,documentId,kind,effect,purpose,categoryKind = null,
      categoryCode = null,relatedDocument = null,relatedEvent = null) =>
      [id,generalId,documentId,kind,effect,categoryKind,categoryCode,purpose,
        relatedDocument,relatedEvent];
    let client;
    try {
      // The opt-in variable names a dedicated disposable test database.
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      for (const propertyId of properties) {
        await admin.query(`INSERT INTO iron_gate.property_state
          (property_id,workspace_id,authority_epoch,inventory_version,state_json)
          VALUES ($1,$2,1,1,$3::jsonb)`, [propertyId,workspaceId,
          JSON.stringify({propertyId,workspaceId,authorityEpoch:1,version:1,
            roomIds:[],readOnly:false,bookings:[]})]);
        await admin.query(`INSERT INTO iron_gate.finance_connector
          (source_instance_id,property_id,source_system,enabled,cutover_at)
          VALUES ($1,$2,'os_manual',true,now()-interval '1 day')`,
          [connectors.get(propertyId),propertyId]);
      }
      for (const propertyId of [generalId,otherScopedId])
        await admin.query(`INSERT INTO iron_gate.finance_write_scope
          (property_id,mode) VALUES ($1,'general_only')`, [propertyId]);
      await admin.query(`INSERT INTO iron_gate.finance_category
        (property_id,kind,code,label) VALUES ($1,'expense','supplies','Supplies')`,
        [generalId]);
      for (const [documentId,recordId] of [
        [expenseDocumentId,'scope-expense'],[receiptDocumentId,'scope-receipt']]) {
        await admin.query(documentInsert,
          [documentId,generalId,connectors.get(generalId),recordId]);
        await admin.query(`INSERT INTO iron_gate.finance_revision
          (property_id,document_id,version,action,request_hash,
           source_version,actor_ref)
          VALUES ($1,$2,1,'create',$3,'1','synthetic-operator')`,
          [generalId,documentId,'a'.repeat(64)]);
      }
      // A later administrator can import an old booking-linked OS receipt.
      // Its matching source metadata must not make it editable by general_only.
      const imported = await admin.connect();
      try {
        await imported.query('BEGIN');
        await imported.query(documentInsert,[importedBookingDocumentId,generalId,
          connectors.get(generalId),'imported-booking-receipt']);
        await imported.query(`INSERT INTO iron_gate.finance_revision
          (property_id,document_id,version,action,request_hash,
           source_version,actor_ref)
          VALUES ($1,$2,1,'create',$3,'1','admin-import')`,
          [generalId,importedBookingDocumentId,'b'.repeat(64)]);
        await imported.query(eventInsert,event(importedBookingEventId,
          importedBookingDocumentId,'property_receipt',100,'room'));
        await imported.query(`INSERT INTO iron_gate.finance_allocation
          (property_id,event_id,booking_id,amount_cents,allocation_kind)
          VALUES ($1,$2,$3,100,'room')`,
          [generalId,importedBookingEventId,randomUUID()]);
        await imported.query('COMMIT');
      } finally {
        await imported.query('ROLLBACK').catch(() => {});
        imported.release();
      }

      client = await runtime.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE iron_gate_runtime');
      const setProperty = id => client.query(
        "SELECT set_config('iron_gate.property_id',$1,true)",[id]);
      await setProperty(unscopedId);
      await denied(client,documentInsert,
        [randomUUID(),unscopedId,connectors.get(unscopedId),'no-scope']);
      await setProperty(generalId);
      await denied(client,documentInsert,
        [randomUUID(),otherScopedId,connectors.get(otherScopedId),'other-property']);
      await denied(client,`INSERT INTO iron_gate.finance_write_scope
        (property_id,mode) VALUES ($1,'full')`,[unscopedId],false);
      await denied(client,`UPDATE iron_gate.finance_write_scope SET mode='full'
        WHERE property_id=$1`,[generalId],false);
      await denied(client,`DELETE FROM iron_gate.finance_write_scope
        WHERE property_id=$1`,[generalId],false);
      const importedUpdate = await client.query(`UPDATE iron_gate.finance_document
        SET current_version=2,updated_at=now() WHERE id=$1`,
        [importedBookingDocumentId]);
      assert.equal(importedUpdate.rowCount,0);
      await denied(client,`INSERT INTO iron_gate.finance_revision
        (property_id,document_id,version,action,request_hash,
         source_version,actor_ref)
        VALUES ($1,$2,2,'amend',$3,'2','synthetic-operator')`,
        [generalId,importedBookingDocumentId,'c'.repeat(64)]);
      await denied(client,eventInsert,event(randomUUID(),
        importedBookingDocumentId,'property_receipt',100,'other'));

      for (const purpose of ['room','deposit','extra'])
        await denied(client,eventInsert,event(randomUUID(),receiptDocumentId,
          'property_receipt',100,purpose));
      await denied(client,eventInsert,event(randomUUID(),expenseDocumentId,
        'expense_paid',-100,'room','expense','supplies'));
      await denied(client,`INSERT INTO iron_gate.finance_category
        (property_id,kind,code,label)
        VALUES ($1,'expense','ordinary_new','Ordinary new')`,[generalId]);
      await denied(client,`INSERT INTO iron_gate.finance_account
        (id,property_id,code,display_name,kind)
        VALUES ($1,$2,'scope-bank','Scope bank','bank')`,
        [randomUUID(),generalId]);
      await denied(client,`INSERT INTO iron_gate.finance_operational_status
        (id,property_id,source_instance_id,source_record_id,version,status_code)
        VALUES ($1,$2,$3,'scope-status',1,'room_confirmed')`,
        [randomUUID(),generalId,connectors.get(generalId)]);
      await denied(client,`INSERT INTO iron_gate.finance_recurring_rule
        (id,property_id,source_instance_id,source_record_id,version,cadence,
         start_on,next_due_on,status,category_code)
        VALUES ($1,$2,$3,'scope-rule',1,'monthly','2026-10-01',
          '2026-11-01','active','supplies')`,
        [randomUUID(),generalId,connectors.get(generalId)]);
      await denied(client,`INSERT INTO iron_gate.finance_payout_rule
        (property_id,platform,mode,version,status)
        VALUES ($1,'scope-platform','manual',1,'active')`,[generalId]);

      await client.query(eventInsert,event(expenseEventId,expenseDocumentId,
        'expense_paid',-100,null,'expense','supplies'));
      await client.query(`INSERT INTO iron_gate.finance_expense_attribution
        (property_id,event_id,month,amount_cents,allocation_policy)
        VALUES ($1,$2,'2026-10-01',100,'ig_v1_earliest_cent')`,
        [generalId,expenseEventId]);
      await client.query(eventInsert,event(receiptEventId,receiptDocumentId,
        'property_receipt',100,'other'));
      await denied(client,`INSERT INTO iron_gate.finance_evidence_assertion
        (id,property_id,event_id,evidence_level,evidence_ref,actor_ref)
        VALUES ($1,$2,$3,'provider_notice','scope-evidence','synthetic-operator')`,
        [randomUUID(),generalId,receiptEventId]);
      await denied(client,`INSERT INTO iron_gate.finance_settlement
        (id,property_id,source_instance_id,settlement_batch_ref,
         gross_cents,refund_cents,fee_cents,net_cents,evidence_ref)
        VALUES ($1,$2,$3,'scope-settlement',100,0,0,100,'scope-evidence')`,
        [randomUUID(),generalId,connectors.get(generalId)]);
      await denied(client,eventInsert,event(randomUUID(),receiptDocumentId,
        'property_refund',-100,null,null,null,receiptDocumentId,receiptEventId));
      await denied(client,`INSERT INTO iron_gate.finance_allocation
        (property_id,event_id,booking_id,amount_cents,allocation_kind)
        VALUES ($1,$2,$3,100,'room')`,
        [generalId,receiptEventId,randomUUID()]);
      await client.query(`INSERT INTO iron_gate.finance_category
        (property_id,kind,code,label)
        VALUES ($1,'expense','custom_offland_scope','Custom')`,[generalId]);
      await client.query('COMMIT');

      const rows = await admin.query(`SELECT event_kind,receipt_purpose
        FROM iron_gate.finance_event WHERE property_id=$1
        ORDER BY event_kind,receipt_purpose`,
        [generalId]);
      assert.deepEqual(rows.rows,[
        {event_kind:'expense_paid',receipt_purpose:null},
        {event_kind:'property_receipt',receipt_purpose:'other'},
        {event_kind:'property_receipt',receipt_purpose:'room'}]);
      const scoped = await admin.query(`SELECT property_id,mode
        FROM iron_gate.finance_write_scope ORDER BY property_id`);
      assert.equal(scoped.rows.length,2);
      assert.ok(scoped.rows.every(row => row.mode === 'general_only'));
      assert.ok(scoped.rows.every(row => row.property_id !== unscopedId));
      const importedVersion = await admin.query(`SELECT current_version
        FROM iron_gate.finance_document WHERE id=$1`,
        [importedBookingDocumentId]);
      assert.equal(importedVersion.rows[0].current_version,1);
    } finally {
      if (client) {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end();
      await admin.end();
    }
  });
