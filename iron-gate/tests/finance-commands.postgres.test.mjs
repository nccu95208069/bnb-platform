import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE === 'iron_gate_finance_test3';
const poolConfig = { host: '/private/tmp', port: 55432, database: 'iron_gate_finance_test3' };
const workspaceId = '10000000-0000-4000-8000-000000000001';
const propertyId = '10000000-0000-4000-8000-000000000002';
const otherPropertyId = '10000000-0000-4000-8000-000000000003';
const bookingId = '10000000-0000-4000-8000-000000000004';
const connectorId = '10000000-0000-4000-8000-000000000005';
const importConnectorId = '10000000-0000-4000-8000-000000000006';
const lineConnectorId = '10000000-0000-4000-8000-000000000010';
const lineBookingId = '10000000-0000-4000-8000-000000000011';
const sheetConnectorId = '10000000-0000-4000-8000-000000000012';
const sheetRowId = '10000000-0000-4000-8000-000000000013';
const sheetRef = 'SyntheticSheet_0123456789';
const secret = 'synthetic-finance-test-secret-32-bytes-long';

function state(id, booking = false) {
  return { propertyId: id, workspaceId, authorityEpoch: 1, version: 1,
    roomIds: [], readOnly: false, bookings: booking ? [{ id: bookingId,
      propertyId: id, version: 1, status: 'confirmed', source: 'os',
      sourceCalendar: null, totalCents: 10000, currency: 'TWD', paymentEvents: [] }] : [] };
}
const principal = { origin: 'os', workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
  subjectId: 'synthetic-operator', financeSourceInstanceId: connectorId,
  actions: ['finance:read','finance:record_receipt','finance:record_expense',
    'finance:correct','finance:refund','finance:status','finance:plan',
    'finance:evidence','finance:settlement'] };
function expense(action, sourceVersion, amount = 1000) {
  return { request_key: `expense-${sourceVersion}`, source_record_id: 'expense-1',
    source_version: sourceVersion, ...(action === 'create' ? {} : { expected_version: Number(sourceVersion) - 1 }),
    action, ...(action === 'void' ? {} : { event_kind: 'expense_paid', amount_cents: amount,
      currency: 'TWD', effective_on: '2026-10-28', cash_on: '2026-10-28',
      category_code: 'supplies', evidence_level: 'operator_attested',
      advanced_by_ref:'synthetic-operator',advanced_by_kind:'self',
      advanced_by_label:'Synthetic operator',
      expense_attributions: [{ month: '2026-10-01', amount_cents: amount,
        allocation_policy: 'ig_v1_earliest_cent' }] }) };
}
function roomCommand(record, amount) {
  return { request_key: `receipt-${record}`, source_record_id: record, source_version: '1',
    action: 'create', event_kind: 'property_receipt', amount_cents: amount,
    currency: 'TWD', effective_on: '2026-10-28', cash_on: '2026-10-28',
    receipt_purpose: 'room', evidence_level: 'operator_attested',
    booking_allocations: [{ booking_id: bookingId, expected_booking_version: 1,
      amount_cents: amount, allocation_kind: 'room' }] };
}

test('finance commands commit atomically, retry exactly, and isolate the property',
  { skip: !enabled }, async () => {
    const admin = new Pool(poolConfig);
    const runtime = new Pool(poolConfig);
    const service = new FinanceCommandService({ connect: async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } }, secret, true);
    try {
      // This environment variable deliberately names a disposable, dedicated database.
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      for (const [id, withBooking] of [[propertyId, true], [otherPropertyId, false]])
        await admin.query(`INSERT INTO iron_gate.property_state
          (property_id,workspace_id,authority_epoch,inventory_version,state_json)
          VALUES ($1,$2,1,1,$3::jsonb)`, [id, workspaceId, JSON.stringify(state(id, withBooking))]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$2,'os_manual',true,now()-interval '1 day')`, [connectorId, propertyId]);
      await admin.query(`INSERT INTO iron_gate.finance_category(property_id,kind,code,label)
        VALUES ($1,'expense','supplies','Supplies')`, [propertyId]);
      await admin.query(`INSERT INTO iron_gate.finance_source_link
        (property_id,source_instance_id,source_order_key,booking_id,
         verified_booking_version,source_snapshot_hash,evidence_ref)
        VALUES ($1,$2,'SF-EXACT-1',$3,1,$4,'synthetic-link')`,
        [propertyId,connectorId,bookingId,'a'.repeat(64)]);
      const first = expense('create', '1');
      await assert.rejects(service.command(principal, propertyId,
        { ...first, evidence_level: 'bank_reconciled' }, first.request_key),
      e => e.code === 'SOURCE_FORBIDDEN');
      const receipt = await service.command(principal, propertyId, first, first.request_key);
      assert.equal(receipt.document_version, 1);
      assert.deepEqual(await service.command(principal, propertyId, first, first.request_key), receipt);
      assert.deepEqual(await service.receipt(principal, propertyId, first.request_key), receipt);
      await assert.rejects(service.command(principal, propertyId,
        { ...first, amount_cents: 2000,
          expense_attributions: [{ ...first.expense_attributions[0], amount_cents: 2000 }] },
        first.request_key), e => e.code === 'REQUEST_KEY_REUSED');
      const amended = expense('amend', '2', 1200);
      const second = await service.command(principal, propertyId, amended, amended.request_key);
      assert.equal(second.document_version, 2);
      assert.equal(second.event_ids.length, 2);
      const voided = expense('void', '3');
      const third = await service.command(principal, propertyId, voided, voided.request_key);
      assert.equal(third.event_ids.length, 1);
      const balance = await admin.query(`SELECT sum(cash_effect_cents)::bigint AS cents
        FROM iron_gate.finance_event WHERE property_id=$1`, [propertyId]);
      assert.equal(Number(balance.rows[0].cents), 0);
      const room = { ...roomCommand('room-1', 6000), booking_allocations: [{
        source_order_key:'SF-EXACT-1', amount_cents:6000, allocation_kind:'room' }],
        service_on:'2026-11-10',
        payment_method_code:'bank_transfer',provider_transaction_ref:'provider-transaction-1' };
      const preview = await service.preview(principal, propertyId, room, room.request_key);
      assert.equal(preview.bookings[0].bookingId, bookingId);
      assert.equal(preview.resolved_command.booking_allocations[0].booking_id,bookingId);
      const roomAccepted = await service.command(principal, propertyId,
        { ...preview.resolved_command, preview_token: preview.preview_token }, room.request_key);
      const duplicate = roomCommand('room-duplicate', 6000);
      const duplicatePreview = await service.preview(principal, propertyId, duplicate, duplicate.request_key);
      await assert.rejects(service.command(principal, propertyId,
        { ...duplicate, preview_token: duplicatePreview.preview_token }, duplicate.request_key),
      e => e.code === 'SOURCE_MAPPING_REVIEW_REQUIRED');
      const transactionDuplicate = { ...roomCommand('room-provider-duplicate',2000),
        payment_method_code:'bank_transfer',provider_transaction_ref:'provider-transaction-1' };
      const transactionPreview = await service.preview(principal,propertyId,
        transactionDuplicate,transactionDuplicate.request_key);
      await assert.rejects(service.command(principal,propertyId,
        { ...transactionDuplicate,preview_token:transactionPreview.preview_token },
        transactionDuplicate.request_key),e => e.code === 'SOURCE_MAPPING_REVIEW_REQUIRED');
      const refund = { request_key: 'refund-1', source_record_id: 'refund-1', source_version: '1',
        action: 'create', event_kind: 'property_refund', amount_cents: 3000,
        currency: 'TWD', effective_on: '2026-10-28', cash_on: '2026-10-28',
        related_receipt_document_id: roomAccepted.document_id,
        related_receipt_event_id: roomAccepted.event_ids[0],
        evidence_level: 'operator_attested', booking_allocations: [{ booking_id: bookingId,
          expected_booking_version: 1, amount_cents: 3000, allocation_kind: 'room' }] };
      const refundPreview = await service.preview(principal, propertyId, refund, refund.request_key);
      const refundAccepted = await service.command(principal, propertyId,
        { ...refund, preview_token: refundPreview.preview_token }, refund.request_key);
      const refundAmend = { ...refund, request_key:'refund-amend', source_version:'2',
        expected_version:1, action:'amend', amount_cents:2000,
        booking_allocations:[{...refund.booking_allocations[0],amount_cents:2000}] };
      const refundAmendPreview = await service.preview(principal,propertyId,
        refundAmend,refundAmend.request_key);
      await assert.rejects(service.command({ ...principal,
        actions:principal.actions.filter(action => action !== 'finance:refund') },propertyId,
        { ...refundAmend, preview_token: refundAmendPreview.preview_token },refundAmend.request_key),
      e => e.code === 'PROPERTY_FORBIDDEN');
      const amendedRefund = await service.command(principal,propertyId,
        { ...refundAmend, preview_token: refundAmendPreview.preview_token },refundAmend.request_key);
      assert.equal(amendedRefund.document_version,2);
      const projection = await service.bookingFinance(principal, propertyId, bookingId);
      assert.equal(projection.summary.room_received_cents,6000);
      assert.equal(projection.summary.room_refunded_cents,2000);
      assert.equal(projection.remaining_due_cents,6000);
      const ledger = await service.ledger(principal, propertyId,
        { from:'2026-10-28', to:'2026-10-29', limit:2 });
      assert.equal(ledger.events.length,2);
      assert.ok(ledger.next_cursor);
      const secondPage = await service.ledger(principal, propertyId,
        { from:'2026-10-28', to:'2026-10-29', limit:10, cursor:ledger.next_cursor });
      assert.ok(secondPage.events.length >= 2);
      const fullLedger = await service.ledger(principal,propertyId,{limit:100});
      assert.equal(fullLedger.events.find(event=>event.document_id===receipt.document_id &&
        event.event_kind==='expense_paid')?.advanced_by_kind,'self');
      assert.equal(fullLedger.events.find(event=>event.document_id===receipt.document_id &&
        event.event_kind==='expense_paid')?.origin_actor_ref,'synthetic-operator');
      assert.equal(fullLedger.events.find(event=>event.document_id===receipt.document_id &&
        event.event_kind==='reversal')?.reversed_kind,'expense_paid');
      assert.equal(fullLedger.events.find(event=>event.document_id===refundAccepted.document_id &&
        event.event_kind==='property_refund')?.related_receipt_purpose,'room');
      assert.equal(fullLedger.events.find(event=>event.document_id===refundAccepted.document_id &&
        event.event_kind==='property_refund')?.related_receipt_service_on,'2026-11-10');
      const activity = await service.activity(principal,propertyId,1,'expense_voided','synthetic-operator');
      assert.equal(activity.total,1);
      assert.equal(activity.activities[0].target_id,receipt.document_id);
      assert.equal(activity.activities[0].before_amount_cents,'1200');
      assert.equal(activity.activities[0].ui_action,'expense_voided');
      assert.equal((await service.activity(principal,propertyId,1,'','no-such-operator')).total,0);
      const expenses = await service.expenses(principal, propertyId,'2026-10-01');
      assert.equal(expenses.total_cents,0);
      const beforeStatus = await admin.query(`SELECT count(*)::int AS count
        FROM iron_gate.finance_event WHERE property_id=$1`, [propertyId]);
      const statusInput = { request_key:'status-1',source_record_id:'legacy-status-1',
        version:1,status_code:'room_confirmed',settles_room:true,
        booking_id:bookingId,expected_booking_version:1 };
      const statusResult = await service.statusCommand(principal,propertyId,
        statusInput,statusInput.request_key);
      assert.equal(statusResult.cash_effect_cents,0);
      assert.deepEqual(await service.statusCommand(principal,propertyId,
        statusInput,statusInput.request_key),statusResult);
      assert.equal((await service.statuses(principal,propertyId,bookingId)).statuses.length,1);
      const recurring = { request_key:'rule-1',source_record_id:'monthly-1',version:1,
        cadence:'monthly',start_on:'2026-10-01',end_on:null,next_due_on:'2026-11-01',
        status:'active',category_code:'supplies',amount_cents:2000,
        safe_description:'Monthly supplies',payment_method_code:'bank_transfer',due_day:10 };
      const rule = await service.recurringRule(principal,propertyId,recurring,recurring.request_key);
      assert.equal(rule.cash_effect_cents,0);
      assert.equal((await service.recurringRules(principal,propertyId)).recurring_rules.length,1);
      const payout = { request_key:'payout-rule-1',platform:'booking',version:1,
        mode:'fixed_day',day:10,offset_months:1,status:'active' };
      await service.payoutRule(principal,propertyId,payout,payout.request_key);
      assert.equal((await service.payoutRules(principal,propertyId)).payout_rules.length,1);
      const account = {request_key:'account-1',code:'os-account-1',
        display_name:'Test account',kind:'bank',last_digits:'12345'};
      const accountResult = await service.accountCommand(principal,propertyId,
        account,account.request_key);
      assert.equal(accountResult.cash_effect_cents,0);
      assert.equal((await service.accounts(principal,propertyId)).accounts[0].last_digits,'12345');
      const category = {request_key:'category-1',code:'custom_test',
        label:'Test category',kind:'expense'};
      await service.categoryCommand(principal,propertyId,category,category.request_key);
      assert.equal((await service.categories(principal,propertyId)).categories.length,2);
      const accountActivity=await service.activity(principal,propertyId,1,
        'payment_account_created','synthetic-operator');
      assert.equal(accountActivity.total,1);
      assert.equal(accountActivity.activities[0].target_id,'os-account-1');
      const afterStatus = await admin.query(`SELECT count(*)::int AS count
        FROM iron_gate.finance_event WHERE property_id=$1`, [propertyId]);
      assert.equal(afterStatus.rows[0].count,beforeStatus.rows[0].count);
      const fee = { request_key:'fee-1',source_record_id:'fee-1',source_version:'1',
        action:'create',event_kind:'processor_fee_paid',amount_cents:100,
        currency:'TWD',effective_on:'2026-10-28',cash_on:'2026-10-28',
        payment_method_code:'bank_transfer',payment_account_ref:'os-account-1',
        category_code:'supplies',evidence_level:'operator_attested',
        expense_attributions:[{month:'2026-10-01',amount_cents:100,
          allocation_policy:'ig_v1_earliest_cent'}] };
      const feeAccepted = await service.command(principal,propertyId,fee,fee.request_key);
      const assertion = { request_key:'assertion-1',event_id:roomAccepted.event_ids[0],
        evidence_level:'processor_confirmed',evidence_ref:'synthetic-processor-proof',
        processor_transaction_ref:'synthetic-transaction-1' };
      const assertionResult = await service.evidenceAssertion(principal,propertyId,
        assertion,assertion.request_key);
      assert.equal(assertionResult.cash_effect_cents,0);
      const verified = await service.bookingFinance(principal,propertyId,bookingId);
      assert.equal(verified.events.find(event => event.id===roomAccepted.event_ids[0]).evidence_level,
        'processor_confirmed');
      const tooSmall = { ...preview.resolved_command, request_key: 'room-amend', source_version: '2',
        expected_version: 1, action: 'amend', amount_cents: 1000,
        booking_allocations: [{ ...preview.resolved_command.booking_allocations[0], amount_cents: 1000 }] };
      const tooSmallPreview = await service.preview(principal, propertyId, tooSmall, tooSmall.request_key);
      await assert.rejects(service.command(principal, propertyId,
        { ...tooSmall, preview_token: tooSmallPreview.preview_token }, tooSmall.request_key),
      e => e.code === 'REFUND_LIMIT');
      const settlement = { request_key:'settlement-1',
        settlement_batch_ref:'synthetic-batch-1',gross_cents:6000,refund_cents:2000,
        fee_cents:100,net_cents:3900,bank_on:'2026-10-28',
        evidence_ref:'synthetic-batch-proof',links:[
          {event_id:roomAccepted.event_ids[0],role:'gross',amount_cents:6000},
          {event_id:amendedRefund.event_ids.at(-1),role:'refund',amount_cents:2000},
          {event_id:feeAccepted.event_ids[0],role:'fee',amount_cents:100} ] };
      const settled = await service.settlement(principal,propertyId,
        settlement,settlement.request_key);
      assert.equal(settled.cash_effect_cents,0);
      assert.equal((await service.settlements(principal,propertyId)).settlements.length,1);
      const settledRefundAmend = { ...refundAmend, request_key:'refund-amend-after-settlement',
        source_version:'3', expected_version:2, amount_cents:1000,
        booking_allocations:[{...refund.booking_allocations[0],amount_cents:1000}] };
      const settledRefundPreview = await service.preview(principal,propertyId,
        settledRefundAmend,settledRefundAmend.request_key);
      await assert.rejects(service.command(principal,propertyId,
        { ...settledRefundAmend,preview_token:settledRefundPreview.preview_token },
        settledRefundAmend.request_key),e => e.code === 'SETTLEMENT_REVIEW_REQUIRED');
      const excessive = roomCommand('room-excess', 8000);
      const excessivePreview = await service.preview(principal, propertyId, excessive, excessive.request_key);
      await assert.rejects(service.command(principal, propertyId,
        { ...excessive, preview_token: excessivePreview.preview_token }, excessive.request_key),
      e => e.code === 'ALLOCATION_MISMATCH');
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled)
        VALUES ($1,$2,'os_legacy_payment',true)`,[importConnectorId,propertyId]);
      const importer = { ...principal,origin:'finance',
        financeSourceInstanceId:importConnectorId,
        actions:['finance:import','finance:refund'] };
      const link = { request_key:'reviewed-link-1',source_order_key:'SF-IMPORTED-1',
        booking_id:bookingId,expected_booking_version:1,
        source_snapshot_hash:'b'.repeat(64),evidence_ref:'synthetic-review-1',
        review_confirmed:true };
      const linkPreview = await service.sourceLinkPreview(importer,propertyId,
        link,link.request_key);
      const linked = await service.sourceLinkCommit(importer,propertyId,
        { ...link,preview_token:linkPreview.preview_token },link.request_key);
      assert.equal(linked.cash_effect_cents,0);
      assert.equal((await service.sourceLinks(principal,propertyId)).source_links.length,2);
      assert.deepEqual(await service.sourceLinkCommit(importer,propertyId,
        { ...link,preview_token:linkPreview.preview_token },link.request_key),linked);
      const imported = { ...roomCommand('legacy-receipt-1',1000),
        booking_allocations:[{source_order_key:'SF-IMPORTED-1',
          amount_cents:1000,allocation_kind:'room'}] };
      const importPreview = await service.importPreview(importer,propertyId,
        imported,imported.request_key);
      const importReceipt = await service.importCommand(importer,propertyId,
        {...importPreview.resolved_command,preview_token:importPreview.preview_token},
        imported.request_key);
      assert.equal(importReceipt.receipt_status,'accepted');
      assert.deepEqual(await service.importReceipt(importer,propertyId,
        imported.request_key),importReceipt);
      assert.equal((await service.importLedger(importer,propertyId,
        {limit:100})).events.some(event => event.document_id===importReceipt.document_id),true);
      const issue = { request_key:'import-issue-1',source_record_id:'legacy-ambiguous-1',
        source_version:'1',reason_code:'BOOKING_MAPPING_AMBIGUOUS',severity:'blocking' };
      const flagged = await service.importIssue(importer,propertyId,issue,issue.request_key);
      assert.equal(flagged.issue_status,'open');
      assert.deepEqual(await service.importIssue(importer,propertyId,issue,
        issue.request_key),flagged);
      await assert.rejects(service.importIssue(importer,propertyId,
        {...issue,request_key:'import-issue-conflict',severity:'classification_only'},
        'import-issue-conflict'),e => e.code === 'SOURCE_MAPPING_REVIEW_REQUIRED');
      assert.equal((await service.importIssues(importer,propertyId)).issues.length,1);
      const resolution = {request_key:'import-issue-resolve-1',
        resolution_ref:'synthetic-review-2'};
      const resolved = await service.resolveImportIssue(importer,propertyId,
        flagged.issue_id,resolution,resolution.request_key);
      assert.equal(resolved.issue_status,'resolved');
      assert.equal((await service.importIssues(importer,propertyId)).issues.length,0);
      await assert.rejects(service.command(importer,propertyId,importPreview.resolved_command,
        imported.request_key),e => e.code === 'PROPERTY_FORBIDDEN');
      await admin.query(`UPDATE iron_gate.finance_connector SET cutover_at=now()-interval '1 day',
        version=version+1,updated_at=clock_timestamp()
        WHERE source_instance_id=$1`,[importConnectorId]);
      assert.deepEqual(await service.importReceipt(importer,propertyId,
        imported.request_key),importReceipt);
      assert.equal((await service.importLedger(importer,propertyId,{limit:100})).events
        .some(event => event.document_id===importReceipt.document_id),true);
      await assert.rejects(service.importCommand(importer,propertyId,
        {...importPreview.resolved_command,preview_token:importPreview.preview_token},
        imported.request_key),e => e.code === 'SOURCE_FORBIDDEN');
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$2,'line_finance',true,now()-interval '1 day')`,
        [lineConnectorId,propertyId]);
      const line={...principal,origin:'line',financeSourceInstanceId:lineConnectorId,
        actions:['finance:read','finance:link','finance:record_receipt','finance:correct']};
      const lineState=await admin.query(`SELECT state_json FROM iron_gate.property_state
        WHERE property_id=$1`,[propertyId]);
      const directState=lineState.rows[0].state_json;
      directState.bookings.push({...directState.bookings[0],id:lineBookingId,
        source:'external',sourceCalendar:{platform:'Booking.com',externalOrderNo:'SYN-1'},
        paymentEvents:[],version:1});
      await admin.query(`UPDATE iron_gate.property_state SET state_json=$1::jsonb
        WHERE property_id=$2`,[JSON.stringify(directState),propertyId]);
      const direct={...roomCommand('line:10000000000040008000000000000012',2000),
        booking_allocations:[{booking_id:lineBookingId,expected_booking_version:1,
          amount_cents:2000,allocation_kind:'room'}]};
      const directPreview=await service.preview(line,propertyId,direct,direct.request_key);
      assert.equal(directPreview.bookings[0].bookingId,lineBookingId);
      const directAccepted=await service.command(line,propertyId,
        {...direct,preview_token:directPreview.preview_token},direct.request_key);
      assert.equal(directAccepted.receipt_status,'accepted');
      const directVoid={request_key:'line-direct-void',source_record_id:direct.source_record_id,
        source_version:'2',expected_version:1,action:'void'};
      await assert.rejects(service.preview(line,propertyId,directVoid,directVoid.request_key),
        e=>e.code==='VERSION_CONFLICT');
      const guarded={...directVoid,booking_guards:[{booking_id:lineBookingId,
        expected_booking_version:1}]};
      const guardedPreview=await service.preview(line,propertyId,guarded,guarded.request_key);
      assert.equal(guardedPreview.bookings[0].bookingId,lineBookingId);
      const voidReceipt=await service.command(line,propertyId,
        {...guarded,preview_token:guardedPreview.preview_token},guarded.request_key);
      assert.equal(voidReceipt.receipt_status,'accepted');
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,source_sheet_ref,enabled,cutover_at)
        VALUES ($1,$2,'sheet_bulk',$3,true,now()-interval '1 day')`,
        [sheetConnectorId,propertyId,sheetRef]);
      const sheet={...principal,financeSourceInstanceId:sheetConnectorId};
      const sheetCommand={...roomCommand(`sheet:${sheetRef}:${sheetRowId}`,1500),
        request_key:'sheet-correct-workbook',evidence_ref:'sheet:'+'a'.repeat(64)};
      const sheetPreview=await service.preview(sheet,propertyId,sheetCommand,
        sheetCommand.request_key);
      assert.equal(sheetPreview.bookings[0].bookingId,bookingId);
      const sheetReceipt=await service.command(sheet,propertyId,
        {...sheetPreview.resolved_command,preview_token:sheetPreview.preview_token},
        sheetCommand.request_key);
      assert.equal(sheetReceipt.receipt_status,'accepted');
      const wrongSheet={...sheetCommand,request_key:'sheet-wrong-workbook',
        source_record_id:`sheet:AnotherSheet_0123456789:${sheetRowId}`};
      await assert.rejects(service.preview(sheet,propertyId,wrongSheet,
        wrongSheet.request_key),e=>e.code==='SOURCE_FORBIDDEN');
      const exact={request_key:'line-link-1',source_order_key:`${bookingId}:v1`,
        booking_id:bookingId,expected_booking_version:1,review_confirmed:true};
      const exactPreview=await service.liveSourceLinkPreview(line,propertyId,
        exact,exact.request_key);
      const exactReceipt=await service.liveSourceLinkCommit(line,propertyId,
        {...exact,preview_token:exactPreview.preview_token},exact.request_key);
      assert.equal(exactReceipt.source_snapshot_hash,exactPreview.source_snapshot_hash);
      assert.deepEqual(await service.liveSourceLinkCommit(line,propertyId,
        {...exact,preview_token:exactPreview.preview_token},exact.request_key),exactReceipt);
      await new Promise(resolve=>setTimeout(resolve,5));
      const retryPreview=await service.liveSourceLinkPreview(line,propertyId,
        exact,exact.request_key);
      assert.deepEqual(await service.liveSourceLinkCommit(line,propertyId,
        {...exact,preview_token:retryPreview.preview_token},exact.request_key),exactReceipt);
      await assert.rejects(service.liveSourceLinkPreview(line,propertyId,
        {...exact,request_key:'line-link-rebind',source_order_key:'SF-OTHER'},
        'line-link-rebind'),e=>e.code==='INVALID_INPUT');
      await admin.query(`UPDATE iron_gate.property_state SET
        state_json=jsonb_set(state_json,'{bookings,0,version}','2'::jsonb)
        WHERE property_id=$1`,[propertyId]);
      await assert.rejects(service.liveSourceLinkPreview(line,propertyId,
        {...exact,request_key:'line-link-stale'},'line-link-stale'),
        e=>e.code==='VERSION_CONFLICT');
      const fresh={...exact,request_key:'line-link-refresh',
        source_order_key:`${bookingId}:v2`,expected_booking_version:2};
      const freshPreview=await service.liveSourceLinkPreview(line,propertyId,
        fresh,fresh.request_key);
      const freshReceipt=await service.liveSourceLinkCommit(line,propertyId,
        {...fresh,preview_token:freshPreview.preview_token},fresh.request_key);
      assert.equal(freshReceipt.booking_version,2);
      const versioned=(await service.sourceLinks(line,propertyId)).source_links
        .filter(row=>row.source_order_key.startsWith(bookingId+':v'));
      assert.deepEqual(versioned.map(row=>row.verified_booking_version).sort(),['1','2']);
      await assert.rejects(service.receipt(principal, otherPropertyId, first.request_key),
        e => e.code === 'PROPERTY_FORBIDDEN');
    } finally {
      await admin.query('TRUNCATE iron_gate.property_state CASCADE');
      await runtime.end(); await admin.end();
    }
  });
