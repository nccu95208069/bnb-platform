import { createHash, randomUUID } from 'node:crypto';
import { cardFingerprint, cardPaymentId } from './card-sync.ts';
import { GateError } from './errors.ts';
import { appendFinanceChange, linkFinanceEvents } from './finance-change.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_AMOUNT = 1_000_000_000_000;
const SYSTEMS = new Set(['iron_gate_native', 'sweetfun_card']);
const METHODS = new Set(['cash', 'bank_transfer', 'credit_card', 'other']);
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function issue(record, code) { return { record, code }; }
function date(value) {
  return typeof value === 'string' && DAY.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dayInTaipei(timestamp) {
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return null;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const part = name => parts.find(item => item.type === name)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function sourceActor(actor, propertyId) {
  return typeof actor === 'string' && actor.length > 0 && actor.length <= 256 ?
    `ig_actor:${digest([propertyId,actor])}` : null;
}
function positiveCents(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_AMOUNT;
}
function recordHash(record) { return digest(record); }
function sourceRecordId(record) { return `${record.system}:${record.source_record_id}:v${record.version}`; }

/** Derive only from the locked Iron Gate booking JSON. The returned records contain
 * no guest details, card fields, or original actor identifiers. Every ambiguity is
 * an issue; callers must never silently choose an overlapping money record. */
export function planNativeCardHistory(state, system) {
  if (!SYSTEMS.has(system)) throw new GateError('INVALID_INPUT', 400);
  const issues = [], records = [], receipts = new Map(), refunds = new Map();
  const allIds = new Set();
  if (!state || !UUID.test(state.propertyId ?? '') || !Array.isArray(state.bookings))
    throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
  for (const booking of state.bookings) {
    const base = `${system}:${booking?.id ?? 'unknown'}`;
    if (!UUID.test(booking?.id ?? '') || booking.propertyId !== state.propertyId ||
      !Number.isSafeInteger(booking.version) || booking.version < 1) {
      issues.push(issue(base, 'BOOKING_IDENTITY_INVALID')); continue;
    }
    const events = booking.paymentEvents ?? [], card = booking.cardChargeResults ?? [];
    if (!Array.isArray(events) || !Array.isArray(card)) {
      issues.push(issue(base, 'SOURCE_SHAPE_INVALID')); continue;
    }
    const cardDone = card.filter(row => row?.status === 'done');
    if (cardDone.length > 1) issues.push(issue(base, 'CARD_DONE_OVERLAP'));
    const doneId = cardDone[0]?.paymentEventId ?? null;
    if (system === 'sweetfun_card') {
      if (card.length && booking.source !== 'external')
        issues.push(issue(base, 'CARD_BOOKING_SOURCE_INVALID'));
      const seenFingerprints = new Set();
      card.forEach((result, index) => {
        const ref = `${base}:v${index + 1}`;
        if (!result || !['done', 'fail'].includes(result.status) ||
          !HEX.test(result.fingerprint ?? '') || cardFingerprint(result) !== result.fingerprint ||
          !sourceActor(result.actorId,state.propertyId) ||
          !Number.isFinite(Date.parse(result.recordedAt ?? '')) ||
          !positiveCents(result.amountCents) ||
          (result.status === 'done' ? !date(result.chargeDate) :
            result.chargeDate !== null || result.paymentEventId != null) ||
          seenFingerprints.has(result.fingerprint)) {
          issues.push(issue(ref, 'CARD_RESULT_INVALID')); return;
        }
        seenFingerprints.add(result.fingerprint);
        if (result.status === 'fail' && card.slice(0, index).some(row => row.status === 'done'))
          issues.push(issue(ref, 'CARD_RESULT_ORDER_INVALID'));
        let expectedEvent = null;
        if (result.status === 'done') {
          const matches = events.filter(event => event?.id === result.paymentEventId);
          if (result.paymentEventId !== cardPaymentId(state.propertyId, booking.id) ||
            matches.length !== 1 || matches[0].kind !== 'received' ||
            matches[0].amountCents !== result.amountCents ||
            matches[0].currency !== 'TWD' || matches[0].method !== 'credit_card' ||
            matches[0].actorId !== result.actorId ||
            dayInTaipei(matches[0].occurredAt) !== result.chargeDate ||
            (Number.isSafeInteger(booking.totalCents) &&
              booking.totalCents !== result.amountCents)) {
            issues.push(issue(ref, 'CARD_EVENT_IDENTITY_MISMATCH')); return;
          }
          expectedEvent = { id:result.paymentEventId, kind:'property_receipt',
            amount_cents:result.amountCents, day:result.chargeDate, booking_id:booking.id,
            method:'credit_card', related_receipt_event_id:null,
            evidence_ref:`card:${result.fingerprint}` };
          receipts.set(expectedEvent.id, expectedEvent);
        }
        records.push({ system, source_record_id:booking.id, version:index + 1,
          source_version:result.fingerprint,
          action:result.status === 'fail' ? 'card_fail' : 'create',
          source_actor_ref:sourceActor(result.actorId,state.propertyId), event:expectedEvent });
      });
    }
    if (system === 'iron_gate_native') for (const payment of events) {
      const ref = `${base}:${payment?.id ?? 'unknown'}`;
      if (!UUID.test(payment?.id ?? '') || allIds.has(payment.id)) {
        issues.push(issue(ref, 'PAYMENT_EVENT_ID_INVALID')); continue;
      }
      allIds.add(payment.id);
      if (payment.id === doneId) continue; // Card owns the exact original event.
      const eventDay = dayInTaipei(payment.occurredAt);
      if (!['received','refunded'].includes(payment.kind) ||
        !positiveCents(payment.amountCents) || payment.currency !== 'TWD' ||
        !date(eventDay) || !sourceActor(payment.actorId,state.propertyId) ||
        (payment.method != null && !METHODS.has(payment.method)) ||
        (payment.kind === 'refunded' ? !UUID.test(payment.refundOfEventId ?? '') :
          payment.refundOfEventId != null)) {
        issues.push(issue(ref, 'PAYMENT_EVENT_INVALID')); continue;
      }
      if (payment.kind === 'received' && booking.source !== 'os')
        issues.push(issue(ref, 'EXTERNAL_RECEIPT_REVIEW_REQUIRED'));
      if (payment.kind === 'received' && booking.source === 'os' &&
        !positiveCents(booking.totalCents))
        issues.push(issue(ref, 'BOOKING_TOTAL_UNRESOLVED'));
      if (payment.kind === 'refunded') {
        refunds.set(payment.id, { bookingId:booking.id, amount:payment.amountCents,
          originalId:payment.refundOfEventId, occurredAt:payment.occurredAt });
        if (booking.source === 'external' && payment.refundOfEventId !== doneId)
          issues.push(issue(ref, 'EXTERNAL_REFUND_SOURCE_INVALID'));
      } else receipts.set(payment.id, { id:payment.id, booking_id:booking.id,
        amount_cents:payment.amountCents, occurredAt:payment.occurredAt });
      records.push({ system, source_record_id:payment.id, version:1,
        source_version:'1', action:'create',
        source_actor_ref:sourceActor(payment.actorId,state.propertyId),
        event:{ id:payment.id, kind:payment.kind === 'received' ?
          'property_receipt' : 'property_refund', amount_cents:payment.amountCents,
          day:eventDay, booking_id:booking.id, method:payment.method ?? null,
          related_receipt_event_id:payment.refundOfEventId ?? null,
          evidence_ref:`ig-payment:${payment.id}` } });
    }
  }
  // Native receipts and Card Done are one pool for exact refund matching. For
  // native-only runs, the Card source is obtained from the same immutable state.
  if (system === 'iron_gate_native') for (const booking of state.bookings) {
    const done = (booking.cardChargeResults ?? []).filter(row => row?.status === 'done');
    if (done.length === 1 && UUID.test(done[0].paymentEventId ?? '')) {
      const source = (booking.paymentEvents ?? []).find(row => row?.id === done[0].paymentEventId);
      if (source) receipts.set(source.id, { id:source.id, booking_id:booking.id,
        amount_cents:source.amountCents, occurredAt:source.occurredAt });
    }
  }
  for (const [eventId, refund] of refunds) {
    const original = receipts.get(refund.originalId);
    if (!original || original.booking_id !== refund.bookingId ||
      Date.parse(refund.occurredAt) < Date.parse(original.occurredAt ?? `${original.day}T00:00:00+08:00`)) {
      issues.push(issue(`${system}:${eventId}`, 'REFUND_SOURCE_UNRESOLVED')); continue;
    }
    const total = [...refunds.values()].filter(row => row.originalId === refund.originalId)
      .reduce((sum,row) => sum + row.amount,0);
    if (total > original.amount_cents)
      issues.push(issue(`${system}:${eventId}`, 'REFUND_EXCEEDS_RECEIPT'));
  }
  if (system === 'iron_gate_native') for (const booking of state.bookings) {
    if (booking.source !== 'os' || !positiveCents(booking.totalCents)) continue;
    const net=(booking.paymentEvents ?? []).reduce((sum,event)=>sum+
      (event.kind==='received' ? event.amountCents :
        event.kind==='refunded' ? -event.amountCents : 0),0);
    if (net > booking.totalCents)
      issues.push(issue(`${system}:${booking.id}`,'ROOM_RECEIPT_EXCEEDS_BOOKING'));
  }
  // A duplicated ID anywhere in the original booking JSON is never a new
  // finance record, even if it happened to be filtered as Card Done above.
  const globalIds = new Set();
  for (const booking of state.bookings) for (const payment of booking.paymentEvents ?? []) {
    if (!UUID.test(payment?.id ?? '') || globalIds.has(payment.id))
      issues.push(issue(`${system}:${booking.id}`, 'PAYMENT_EVENT_ID_OVERLAP'));
    globalIds.add(payment?.id);
  }
  return { system, property_id:state.propertyId, records, issues,
    source_hash:digest(records.map(record => ({...record, record_hash:recordHash(record)}))) };
}

function fail(code, status = 409) { throw new GateError(code, status); }
function pgDay(value) {
  if (!(value instanceof Date)) return value;
  return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
}
/** Source-specific W7 adapter. It intentionally has no HTTP route or automatic
 * production runner. A caller must supply a reviewed import principal and pool. */
export class NativeCardHistoryService {
  #pool;
  constructor(pool) { this.#pool=pool; }
  #authorize(principal, propertyId) {
    if (principal?.origin !== 'finance' ||
      !principal.propertyIds?.includes(propertyId) ||
      !principal.actions?.includes('finance:import') ||
      !UUID.test(principal.financeSourceInstanceId ?? '') ||
      !Number.isSafeInteger(principal.authorityEpoch) ||
      typeof principal.subjectId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(principal.subjectId)) fail('SOURCE_FORBIDDEN',403);
  }
  async #transaction(propertyId, write, fn) {
    const client=await this.#pool.connect();
    try {
      await client.query(write ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' :
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SELECT set_config('iron_gate.property_id',$1,true)",[propertyId]);
      const result=await fn(client);
      await client.query('COMMIT');
      return result;
    } catch(error) {
      await client.query('ROLLBACK').catch(()=>{});
      if (error.code === '23505') fail('SOURCE_MAPPING_REVIEW_REQUIRED');
      throw error;
    } finally { client.release(); }
  }
  async #stateAndConnectors(client, principal, propertyId, system, write) {
    const state=await client.query(`SELECT state_json,workspace_id,authority_epoch
      FROM iron_gate.property_state WHERE property_id=$1 ${write ? 'FOR UPDATE' : ''}`,[propertyId]);
    const row=state.rows[0];
    if (!row || row.workspace_id !== principal.workspaceId) fail('PROPERTY_FORBIDDEN',403);
    if (row.state_json.readOnly || Number(row.authority_epoch) !== principal.authorityEpoch)
      fail('AUTHORITY_MOVED');
    const connector=await client.query(`SELECT source_instance_id,source_system,enabled,cutover_at
      FROM iron_gate.finance_connector WHERE property_id=$1 AND source_system
        IN ('iron_gate_native','sweetfun_card')`,[propertyId]);
    const selected=connector.rows.filter(item => item.source_system===system);
    const native=connector.rows.filter(item => item.source_system==='iron_gate_native');
    if (selected.length!==1 || selected[0].source_instance_id!==principal.financeSourceInstanceId ||
      !selected[0].enabled || selected[0].cutover_at != null ||
      system==='sweetfun_card' && native.length!==1)
      fail('SOURCE_FORBIDDEN',403);
    return {state:row.state_json,sourceId:selected[0].source_instance_id,
      nativeId:native[0]?.source_instance_id ?? null};
  }
  async #ledger(client, propertyId) {
    // node-postgres clients execute one query at a time; concurrent query calls
    // on one client are deprecated and obscure the transaction's read order.
    const documents=await client.query(`SELECT id,source_instance_id,source_system,source_record_id,kind,
        current_version,status FROM iron_gate.finance_document WHERE property_id=$1`,[propertyId]),
      revisions=await client.query(`SELECT document_id,version,action,source_version,request_hash,
        source_actor_ref FROM iron_gate.finance_revision WHERE property_id=$1`,[propertyId]),
      events=await client.query(`SELECT id,document_id,revision_version,event_kind,amount_cents,
        cash_effect_cents,effective_on,cash_on,receipt_purpose,payment_method_code,
        related_receipt_document_id,related_receipt_event_id,evidence_ref
        FROM iron_gate.finance_event WHERE property_id=$1`,[propertyId]),
      allocations=await client.query(`SELECT event_id,booking_id,amount_cents,allocation_kind
        FROM iron_gate.finance_allocation WHERE property_id=$1`,[propertyId]),
      owners=await client.query(`SELECT provider_code,booking_id,existing_payment_event_id,
        canonical_document_id,provider_transaction_ref
        FROM iron_gate.finance_payment_ownership WHERE property_id=$1`,[propertyId]),
      aliases=await client.query(`SELECT source_instance_id,source_record_id,canonical_document_id
        FROM iron_gate.finance_source_alias WHERE property_id=$1`,[propertyId]),
      changes=await client.query(`SELECT source_id,source_version FROM iron_gate.finance_change
        WHERE property_id=$1 AND source_kind='document_revision'`,[propertyId]),
      receipts=await client.query(`SELECT source_instance_id,request_key,request_hash,status,response_json
        FROM iron_gate.finance_request_receipt WHERE property_id=$1`,[propertyId]);
    return {documents:documents.rows,revisions:revisions.rows,events:events.rows,
      allocations:allocations.rows,owners:owners.rows,aliases:aliases.rows,
      changes:changes.rows,receipts:receipts.rows};
  }
  #reconcile(plan, ledger, sourceId, nativeId) {
    const issues=[...plan.issues], rows=[];
    const expectedIds=new Set(plan.records.filter(record => record.event).map(record => record.event.id));
    for (const record of plan.records) {
      const key=sourceRecordId(record), event=record.event;
      const issueCount=issues.length;
      const expectedEffect=event ? (event.kind==='property_refund' ?
        -event.amount_cents:event.amount_cents) : 0;
      const doc=ledger.documents.find(item => item.source_instance_id===sourceId &&
        item.source_record_id===record.source_record_id);
      const competingEvent=event && ledger.events.find(item => item.id===event.id &&
        item.document_id!==doc?.id);
      if (competingEvent) issues.push(issue(key,'EVENT_ID_ALREADY_OWNED'));
      const requestKey=`history:${record.system}:${record.source_record_id}:v${record.version}`;
      const receipt=ledger.receipts.find(item => item.source_instance_id===sourceId &&
        item.request_key===requestKey);
      if (receipt && (receipt.request_hash!==recordHash(record) ||
        receipt.status!=='accepted')) issues.push(issue(key,'REQUEST_RECEIPT_CONFLICT'));
      if (receipt && !doc) issues.push(issue(key,'REQUEST_RECEIPT_ORPHAN'));
      if (event) {
        const nativeAlias=ledger.aliases.filter(item => item.source_instance_id===nativeId &&
          item.source_record_id===event.id);
        if (record.system==='iron_gate_native' && nativeAlias.length ||
          record.system==='sweetfun_card' && nativeAlias.length &&
            (nativeAlias.length!==1 || nativeAlias[0].canonical_document_id!==doc?.id))
          issues.push(issue(key,'NATIVE_ALIAS_CONFLICT'));
      }
      if (event?.related_receipt_event_id && !expectedIds.has(event.related_receipt_event_id) &&
        !ledger.events.some(item => item.id===event.related_receipt_event_id &&
          item.event_kind==='property_receipt'))
        issues.push(issue(key,'REFUND_SOURCE_NOT_IMPORTED'));
      if (!doc) {
        if (record.version>1) {
          const first=plan.records.some(item => item.source_record_id===record.source_record_id &&
            item.version===1);
          if (!first) issues.push(issue(key,'CARD_REVISION_GAP'));
        }
        rows.push({record:key,status:issues.length>issueCount?'conflict':'missing',
          expected_cash_effect_cents:expectedEffect,actual_cash_effect_cents:0,
          difference_cents:expectedEffect}); continue;
      }
      if (doc.source_system!==record.system || doc.kind!==(record.system==='sweetfun_card' ?
        'card_result':'money') || doc.status!=='active' ||
        Number(doc.current_version)>plan.records.filter(item =>
          item.source_record_id===record.source_record_id).length)
        issues.push(issue(key,'DOCUMENT_IDENTITY_CONFLICT'));
      const revision=ledger.revisions.find(item => item.document_id===doc.id &&
        Number(item.version)===record.version);
      if (!revision) {
        if (receipt) issues.push(issue(key,'REQUEST_RECEIPT_ORPHAN'));
        rows.push({record:key,status:issues.length>issueCount?'conflict':'missing',
          expected_cash_effect_cents:expectedEffect,actual_cash_effect_cents:0,
          difference_cents:expectedEffect}); continue;
      }
      if (revision.action!==record.action || revision.source_version!==record.source_version ||
        revision.request_hash!==recordHash(record) ||
        revision.source_actor_ref!==record.source_actor_ref ||
        !ledger.changes.some(item => item.source_id===doc.id &&
          item.source_version===String(record.version)))
        issues.push(issue(key,'REVISION_IDENTITY_CONFLICT'));
      const actual=ledger.events.filter(item => item.document_id===doc.id &&
        Number(item.revision_version)===record.version);
      if (!event) {
        if (actual.length) issues.push(issue(key,'CARD_FAIL_HAS_MONEY'));
      } else {
        const a=actual[0], alloc=ledger.allocations.filter(item => item.event_id===event.id),
          owner=ledger.owners.filter(item => item.existing_payment_event_id===event.id);
        const original=event.related_receipt_event_id ? ledger.events.find(item =>
          item.id===event.related_receipt_event_id) : null;
        if (actual.length!==1 || !a || a.id!==event.id || a.event_kind!==event.kind ||
          Number(a.amount_cents)!==event.amount_cents ||
          Number(a.cash_effect_cents)!==(event.kind==='property_refund' ?
            -event.amount_cents:event.amount_cents) ||
          pgDay(a.effective_on)!==event.day || pgDay(a.cash_on)!==event.day ||
          a.receipt_purpose!=='room' || a.payment_method_code!==event.method ||
          a.evidence_ref!==event.evidence_ref ||
          a.related_receipt_event_id!==event.related_receipt_event_id ||
          a.related_receipt_document_id!==(original?.document_id ?? null) ||
          alloc.length!==1 || alloc[0].booking_id!==event.booking_id ||
          alloc[0].allocation_kind!=='room' ||
          Number(alloc[0].amount_cents)!==event.amount_cents || owner.length!==1 ||
          owner[0].provider_code!==record.system || owner[0].booking_id!==event.booking_id ||
          owner[0].canonical_document_id!==doc.id || owner[0].provider_transaction_ref!=null)
          issues.push(issue(key,'EVENT_OWNERSHIP_CONFLICT'));
        if (record.system==='sweetfun_card') {
          const alias=ledger.aliases.filter(item => item.source_instance_id===nativeId &&
            item.source_record_id===event.id);
          if (alias.length!==1 || alias[0].canonical_document_id!==doc.id)
            issues.push(issue(key,'NATIVE_ALIAS_CONFLICT'));
        }
      }
      if (!receipt) issues.push(issue(key,'REQUEST_RECEIPT_MISSING'));
      const actualEffect=actual.reduce((sum,item)=>sum+Number(item.cash_effect_cents),0);
      rows.push({record:key,status:issues.length>issueCount?'conflict':'matched',
        expected_cash_effect_cents:expectedEffect,actual_cash_effect_cents:actualEffect,
        difference_cents:expectedEffect-actualEffect});
    }
    // Any non-source receipt on a booking already paid by native/Card is a
    // possible second representation of the same cash. W7 must review it first.
    const expectedBookings=new Set(plan.records.filter(record =>
      record.event?.kind==='property_receipt').map(record => record.event.booking_id));
    for (const allocation of ledger.allocations) {
      if (!expectedBookings.has(allocation.booking_id) || expectedIds.has(allocation.event_id)) continue;
      const event=ledger.events.find(item => item.id===allocation.event_id);
      const doc=ledger.documents.find(item => item.id===event?.document_id);
      if (event?.event_kind==='property_receipt' && doc?.source_system!==plan.system)
        issues.push(issue(`${plan.system}:${allocation.booking_id}`,'CROSS_SOURCE_OVERLAP_UNRESOLVED'));
    }
    const expectedDocuments=new Set(plan.records.map(record=>record.source_record_id));
    for (const doc of ledger.documents) if (doc.source_instance_id===sourceId &&
      !expectedDocuments.has(doc.source_record_id))
      issues.push(issue(`${plan.system}:${doc.source_record_id}`,'LEDGER_ORPHAN_DOCUMENT'));
    return {records:rows,issues,
      total_difference_cents:rows.reduce((sum,row)=>sum+row.difference_cents,0)};
  }
  async #inspect(client,principal,propertyId,system,write) {
    const context=await this.#stateAndConnectors(client,principal,propertyId,system,write);
    const plan=planNativeCardHistory(context.state,system);
    const ledger=await this.#ledger(client,propertyId);
    const review=this.#reconcile(plan,ledger,context.sourceId,context.nativeId);
    const previewHash=digest({system,propertyId,sourceId:context.sourceId,
      stateHash:digest(context.state),planHash:plan.source_hash,review});
    return {context,plan,ledger,review,previewHash};
  }
  async preview(principal,propertyId,system) {
    this.#authorize(principal,propertyId);
    if (!SYSTEMS.has(system)) fail('INVALID_INPUT',400);
    return this.#transaction(propertyId,false,async client => {
      const found=await this.#inspect(client,principal,propertyId,system,false);
      return { property_id:propertyId,source_system:system,
        source_instance_id:found.context.sourceId,
        preview_hash:found.previewHash,records:found.review.records,
        issues:found.review.issues,
        total_difference_cents:found.review.total_difference_cents,
        ready:found.review.issues.length===0 };
    });
  }
  async commit(principal,propertyId,system,previewHash) {
    this.#authorize(principal,propertyId);
    if (!SYSTEMS.has(system) || !HEX.test(previewHash ?? '')) fail('INVALID_INPUT',400);
    return this.#transaction(propertyId,true,async client => {
      const found=await this.#inspect(client,principal,propertyId,system,true);
      if (found.previewHash!==previewHash) fail('VERSION_CONFLICT');
      if (found.review.issues.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED');
      let imported=0;
      const ordered=system==='iron_gate_native' ? [...found.plan.records].sort((a,b)=>
        Number(a.event.kind==='property_refund')-Number(b.event.kind==='property_refund')) :
        found.plan.records;
      for (const record of ordered) {
        const row=found.review.records.find(item => item.record===sourceRecordId(record));
        if (row.status==='matched') continue;
        const document=await client.query(`SELECT id,current_version FROM iron_gate.finance_document
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
          [propertyId,found.context.sourceId,record.source_record_id]);
        let documentId;
        if (!document.rows.length) {
          if (record.version!==1) fail('VERSION_CONFLICT');
          documentId=randomUUID();
          await client.query(`INSERT INTO iron_gate.finance_document
            (id,property_id,source_instance_id,source_system,source_record_id,kind,
             current_version,status) VALUES ($1,$2,$3,$4,$5,$6,1,'active')`,
            [documentId,propertyId,found.context.sourceId,system,record.source_record_id,
              system==='sweetfun_card'?'card_result':'money']);
        } else {
          documentId=document.rows[0].id;
          if (Number(document.rows[0].current_version)!==record.version-1) fail('VERSION_CONFLICT');
          await client.query(`UPDATE iron_gate.finance_document SET current_version=$1,
            updated_at=now() WHERE property_id=$2 AND id=$3`,[record.version,propertyId,documentId]);
        }
        await client.query(`INSERT INTO iron_gate.finance_revision
          (property_id,document_id,version,action,request_hash,source_version,
           actor_ref,source_actor_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [propertyId,documentId,record.version,record.action,recordHash(record),
            record.source_version,principal.subjectId,record.source_actor_ref]);
        if (record.event) {
          const event=record.event;
          const original=event.related_receipt_event_id ? await client.query(`SELECT e.document_id
            FROM iron_gate.finance_event e JOIN iron_gate.finance_allocation a
              ON a.property_id=e.property_id AND a.event_id=e.id
            WHERE e.property_id=$1 AND e.id=$2 AND e.event_kind='property_receipt'
              AND a.booking_id=$3 AND a.allocation_kind='room'`,
            [propertyId,event.related_receipt_event_id,event.booking_id]) : null;
          if (event.related_receipt_event_id && original.rows.length!==1)
            fail('REFUND_SOURCE_UNRESOLVED');
          await client.query(`INSERT INTO iron_gate.finance_event
            (id,property_id,document_id,revision_version,event_kind,amount_cents,
             cash_effect_cents,effective_on,cash_on,evidence_level,evidence_ref,
             receipt_purpose,payment_method_code,related_receipt_document_id,
             related_receipt_event_id,actor_ref)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'operator_attested',$9,'room',$10,$11,$12,$13)`,
            [event.id,propertyId,documentId,record.version,event.kind,event.amount_cents,
              event.kind==='property_refund'?-event.amount_cents:event.amount_cents,
              event.day,event.evidence_ref,event.method,original?.rows[0]?.document_id ?? null,
              event.related_receipt_event_id,principal.subjectId]);
          await client.query(`INSERT INTO iron_gate.finance_allocation
            (property_id,event_id,booking_id,amount_cents,allocation_kind)
            VALUES ($1,$2,$3,$4,'room')`,
            [propertyId,event.id,event.booking_id,event.amount_cents]);
          await client.query(`INSERT INTO iron_gate.finance_payment_ownership
            (id,property_id,provider_code,booking_id,existing_payment_event_id,
             canonical_document_id)
            VALUES ($1,$2,$3,$4,$5,$6)`,
            [randomUUID(),propertyId,system,event.booking_id,event.id,documentId]);
          if (system==='sweetfun_card') await client.query(`INSERT INTO iron_gate.finance_source_alias
            (property_id,source_instance_id,source_record_id,canonical_document_id,evidence_ref)
            VALUES ($1,$2,$3,$4,$5)`,
            [propertyId,found.context.nativeId,event.id,documentId,event.evidence_ref]);
        }
        const seq=await appendFinanceChange(client,propertyId,'document_revision',
          documentId,String(record.version));
        if (record.event) await linkFinanceEvents(client,propertyId,seq,[record.event.id]);
        const requestKey=`history:${system}:${record.source_record_id}:v${record.version}`;
        await client.query(`INSERT INTO iron_gate.finance_request_receipt
          (property_id,source_instance_id,request_key,request_hash,status,response_json)
          VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
          [propertyId,found.context.sourceId,requestKey,recordHash(record),
            JSON.stringify({receipt_status:'accepted',request_key:requestKey,
              document_id:documentId,document_version:record.version,
              event_ids:record.event?[record.event.id]:[],cash_effect_cents:
                record.event ? record.event.kind==='property_refund' ?
                  -record.event.amount_cents:record.event.amount_cents:0,
              as_of_change_seq:seq})]);
        imported++;
      }
      const after=this.#reconcile(found.plan,await this.#ledger(client,propertyId),
        found.context.sourceId,found.context.nativeId);
      if (after.issues.length || after.records.some(row => row.status!=='matched'))
        fail('SOURCE_MAPPING_REVIEW_REQUIRED');
      return {property_id:propertyId,source_system:system,imported,
        records:after.records,issues:[],total_difference_cents:0,ready:true};
    });
  }
}
