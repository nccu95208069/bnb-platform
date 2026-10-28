import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { FinanceCommandService } from '../src/finance-commands.mjs';

const enabled = process.env.IRON_GATE_FINANCE_TEST_DATABASE === 'iron_gate_finance_test3';
const config = { host:'/private/tmp', port:Number(process.env.IRON_GATE_FINANCE_TEST_PORT ?? 55432),
  database:'iron_gate_finance_test3' };
const workspaceId = randomUUID();
const propertyId = randomUUID();
const firstBookingId = randomUUID();
const secondBookingId = randomUUID();
const osConnectorId = randomUUID();
const lineConnectorId = randomUUID();
const day = '2026-10-01';
const allocation = (bookingId, amount, version = 1, kind = 'room') =>
  ({ booking_id:bookingId, expected_booking_version:version,
    amount_cents:amount, allocation_kind:kind });
const receipt = (key, amount, allocations, purpose = 'room') =>
  ({ request_key:key, source_record_id:key, source_version:'1', action:'create',
    event_kind:'property_receipt', amount_cents:amount, currency:'TWD',
    effective_on:day, cash_on:day, receipt_purpose:purpose,
    evidence_level:'operator_attested', booking_allocations:allocations });
const refund = (key, amount, allocationRow, original) =>
  ({ request_key:key, source_record_id:key, source_version:'1', action:'create',
    event_kind:'property_refund', amount_cents:amount, currency:'TWD',
    effective_on:day, cash_on:day, evidence_level:'operator_attested',
    related_receipt_document_id:original.document_id,
    related_receipt_event_id:original.event_ids.at(-1),
    booking_allocations:[allocationRow] });

test('finance P1 guards preserve allocated refunds and permit only mapped partial receipts',
  { skip:!enabled }, async () => {
    const admin = new Pool(config);
    const runtime = new Pool(config);
    const service = new FinanceCommandService({ connect:async () => {
      const client = await runtime.connect();
      await client.query('SET ROLE iron_gate_runtime');
      return client;
    } }, 'synthetic-finance-test-secret-32-bytes-long', true);
    const os = { origin:'os', workspaceId, propertyIds:[propertyId], authorityEpoch:1,
      subjectId:'synthetic-operator', financeSourceInstanceId:osConnectorId,
      actions:['finance:read','finance:record_receipt','finance:correct','finance:refund'] };
    const line = { ...os, origin:'line', financeSourceInstanceId:lineConnectorId };
    const submit = async (principal, command) => {
      const preview = await service.preview(principal,propertyId,command,command.request_key);
      return service.command(principal,propertyId,
        { ...preview.resolved_command, preview_token:preview.preview_token },command.request_key);
    };
    const rejectCommand = async (principal, command, code) => {
      const preview = await service.preview(principal,propertyId,command,command.request_key);
      await assert.rejects(service.command(principal,propertyId,
        { ...preview.resolved_command, preview_token:preview.preview_token },command.request_key),
      error => error.code === code);
    };
    try {
      const state = { propertyId,workspaceId,authorityEpoch:1,version:1,roomIds:[],
        readOnly:false,bookings:[firstBookingId,secondBookingId].map(id => ({
          id,propertyId,version:1,status:'confirmed',source:'os',sourceCalendar:null,
          totalCents:10000,currency:'TWD',paymentEvents:[] })) };
      await admin.query(`INSERT INTO iron_gate.property_state
        (property_id,workspace_id,authority_epoch,inventory_version,state_json)
        VALUES ($1,$2,1,1,$3::jsonb)`,[propertyId,workspaceId,JSON.stringify(state)]);
      await admin.query(`INSERT INTO iron_gate.finance_write_scope(property_id,mode)
        VALUES ($1,'full')`,[propertyId]);
      await admin.query(`INSERT INTO iron_gate.finance_connector
        (source_instance_id,property_id,source_system,enabled,cutover_at)
        VALUES ($1,$2,'os_manual',true,now()-interval '1 day'),
          ($3,$2,'line_finance',true,now()-interval '1 day')`,
        [osConnectorId,propertyId,lineConnectorId]);

      const original = await submit(os,receipt('split-receipt',8000,[
        allocation(firstBookingId,4000),allocation(secondBookingId,4000)]));
      const firstRefund = await submit(os,refund('first-refund',3000,
        allocation(firstBookingId,3000),original));
      assert.equal(firstRefund.receipt_status,'accepted');
      const reduceFirst = { ...receipt('split-receipt',8000,[
        allocation(firstBookingId,2000),allocation(secondBookingId,6000)]),
        request_key:'reduce-first-allocation',source_version:'2',expected_version:1,
        action:'amend' };
      await rejectCommand(os,reduceFirst,'REFUND_LIMIT');
      const amendedReceipt = { ...reduceFirst,request_key:'valid-split-amend',
        booking_allocations:[allocation(firstBookingId,3500),
          allocation(secondBookingId,4500)] };
      const newOriginal = await submit(os,amendedReceipt);
      assert.equal(newOriginal.document_version,2);

      // The refund keeps its immutable link to receipt v1 after receipt v2.
      state.bookings[0].status='cancelled';
      state.bookings[0].version=2;
      await admin.query(`UPDATE iron_gate.property_state SET state_json=$1::jsonb
        WHERE property_id=$2`,[JSON.stringify(state),propertyId]);
      const smallerRefund = { ...refund('first-refund',2500,
        allocation(firstBookingId,2500,2),original),
        request_key:'amend-old-lineage-refund',source_version:'2',
        expected_version:1,action:'amend' };
      const amendedRefund = await submit(os,smallerRefund);
      assert.equal(amendedRefund.document_version,2);
      const staleNewRefund = refund('stale-new-refund',500,
        allocation(firstBookingId,500,2),original);
      await rejectCommand(os,staleNewRefund,'VERSION_CONFLICT');
      const newRefund = await submit(os,refund('cancelled-booking-refund',500,
        allocation(firstBookingId,500,2),newOriginal));
      assert.equal(newRefund.receipt_status,'accepted');
      await assert.rejects(service.preview(os,propertyId,receipt('cancelled-receipt',100,[
        allocation(firstBookingId,100,2)]),'cancelled-receipt'),
      error => error.code === 'SOURCE_MAPPING_REVIEW_REQUIRED');

      const legacyPaymentId = randomUUID();
      state.bookings[1].paymentEvents=[{ id:legacyPaymentId,kind:'received',
        amountCents:4500,currency:'TWD' }];
      await admin.query(`UPDATE iron_gate.property_state SET state_json=$1::jsonb
        WHERE property_id=$2`,[JSON.stringify(state),propertyId]);
      const partial = receipt('mapped-partial',1000,[allocation(secondBookingId,1000)]);
      await rejectCommand(os,partial,'SOURCE_MAPPING_REVIEW_REQUIRED');
      await admin.query(`INSERT INTO iron_gate.finance_payment_ownership
        (id,property_id,provider_code,booking_id,existing_payment_event_id,
         canonical_document_id) VALUES ($1,$2,'synthetic_legacy',$3,$4,$5)`,
        [randomUUID(),propertyId,secondBookingId,legacyPaymentId,original.document_id]);
      const acceptedPartial = await submit(os,partial);
      assert.equal(acceptedPartial.receipt_status,'accepted');
      assert.equal((await service.bookingFinance(os,propertyId,secondBookingId))
        .legacy_payment_review_required,false);

      const extra = receipt('os-extra',700,[allocation(secondBookingId,700,1,'extra')],'extra');
      await submit(os,extra);
      const duplicateExtra = receipt('line-extra',700,
        [allocation(secondBookingId,700,1,'extra')],'extra');
      await rejectCommand(line,duplicateExtra,'SOURCE_MAPPING_REVIEW_REQUIRED');
      const unverifiedProcessor = { ...receipt('unverified-processor',300,
        [allocation(secondBookingId,300)]), payment_method_code:'credit_card',
        provider_transaction_ref:'ambiguous-processor-reference' };
      await rejectCommand(os,unverifiedProcessor,'SOURCE_MAPPING_REVIEW_REQUIRED');
      await rejectCommand(line,{ ...unverifiedProcessor,
        request_key:'unverified-processor-other-method',
        source_record_id:'unverified-processor-other-method',
        payment_method_code:'other' },'SOURCE_MAPPING_REVIEW_REQUIRED');
    } finally {
      await runtime.end();
      await admin.end();
    }
  });
