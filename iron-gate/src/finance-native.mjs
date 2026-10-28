import { createHash, randomUUID } from 'node:crypto';
import { GateError } from './errors.ts';
import { appendFinanceChange, linkFinanceEvents } from './finance-change.mjs';

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function taipeiDay(timestamp) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  const pick = name => parts.find(part => part.type === name)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** A source cuts over independently. Once its cutover is effective, never
 * silently resume the legacy-only writer when the connector or runtime is off. */
export async function nativeFinanceCutover(client, propertyId, intentType, runtimeEnabled) {
  const sourceSystem = intentType === 'payment' ? 'iron_gate_native' :
    intentType === 'card' ? 'sweetfun_card' : null;
  if (!sourceSystem) throw new GateError('FINANCE_NATIVE_INTENT_INVALID', 500);
  const result = await client.query(`SELECT enabled FROM iron_gate.finance_connector
    WHERE property_id=$1 AND source_system=$2 AND cutover_at IS NOT NULL
      AND cutover_at<=now()`, [propertyId, sourceSystem]);
  if (!result.rows.length) return false;
  if (result.rows.length !== 1 || result.rows[0].enabled !== true)
    throw new GateError('FINANCE_CONNECTOR_NOT_READY', 409);
  if (!runtimeEnabled) throw new GateError('FINANCE_NATIVE_LEDGER_DISABLED', 503);
  return true;
}
async function connector(client, propertyId, sourceSystem) {
  const result = await client.query(`SELECT source_instance_id FROM iron_gate.finance_connector
    WHERE property_id=$1 AND source_system=$2 AND enabled=true AND
      cutover_at IS NOT NULL AND cutover_at<=now()`, [propertyId, sourceSystem]);
  if (result.rows.length !== 1) throw new GateError('FINANCE_CONNECTOR_NOT_READY', 409);
  return result.rows[0].source_instance_id;
}
async function document(client, propertyId, sourceId, system, recordId, kind, version) {
  const found = await client.query(`SELECT id,current_version,status FROM iron_gate.finance_document
    WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
    [propertyId, sourceId, recordId]);
  if (!found.rows.length) {
    if (version !== 1) throw new GateError('FINANCE_DOCUMENT_CONFLICT', 409);
    const id = randomUUID();
    await client.query(`INSERT INTO iron_gate.finance_document
      (id,property_id,source_instance_id,source_system,source_record_id,kind,current_version,status)
      VALUES ($1,$2,$3,$4,$5,$6,1,'active')`, [id,propertyId,sourceId,system,recordId,kind]);
    return { id, version: 1 };
  }
  if (version !== Number(found.rows[0].current_version) + 1 || found.rows[0].status !== 'active')
    throw new GateError('FINANCE_DOCUMENT_CONFLICT', 409);
  await client.query(`UPDATE iron_gate.finance_document SET current_version=$1,updated_at=now()
    WHERE property_id=$2 AND id=$3`, [version,propertyId,found.rows[0].id]);
  return { id: found.rows[0].id, version };
}
async function revision(client, propertyId, doc, action, sourceVersion, actor, intent) {
  await client.query(`INSERT INTO iron_gate.finance_revision
    (property_id,document_id,version,action,request_hash,source_version,actor_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [propertyId,doc.id,doc.version,action,hash(intent),sourceVersion,actor]);
}
async function event(client, propertyId, doc, eventId, kind, amount, day, actor,
  evidenceRef, paymentMethod, receiptDocumentId = null, receiptEventId = null) {
  const effect = kind === 'property_refund' ? -amount : amount;
  await client.query(`INSERT INTO iron_gate.finance_event
    (id,property_id,document_id,revision_version,event_kind,amount_cents,cash_effect_cents,
     effective_on,cash_on,evidence_level,evidence_ref,receipt_purpose,payment_method_code,
     related_receipt_document_id,related_receipt_event_id,actor_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'operator_attested',$9,'room',$10,$11,$12,$13)`,
    [eventId,propertyId,doc.id,doc.version,kind,amount,effect,day,evidenceRef,
      paymentMethod,receiptDocumentId,receiptEventId,actor]);
}
async function allocation(client, propertyId, eventId, bookingId, amount) {
  await client.query(`INSERT INTO iron_gate.finance_allocation
    (property_id,event_id,booking_id,amount_cents,allocation_kind)
    VALUES ($1,$2,$3,$4,'room')`, [propertyId,eventId,bookingId,amount]);
}
async function receipt(client, propertyId, sourceId, intent, response) {
  await client.query(`INSERT INTO iron_gate.finance_request_receipt
    (property_id,source_instance_id,request_key,request_hash,status,response_json)
    VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
    [propertyId,sourceId,intent.requestKey,hash(intent),JSON.stringify(response)]);
}

/** Called inside the same property_state transaction as the legacy compatibility projection. */
export async function appendNativeFinance(client, propertyId, intent, response) {
  if (intent.type === 'payment') {
    const sourceId = await connector(client,propertyId,'iron_gate_native');
    if (intent.sourceInstanceId !== sourceId)
      throw new GateError('SOURCE_FORBIDDEN',403);
    if (intent.bookingSource !== 'os')
      throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    if (intent.previousEventIds?.length) {
      const mapped = await client.query(`SELECT count(*)::int AS total
        FROM iron_gate.finance_payment_ownership WHERE property_id=$1 AND booking_id=$2
          AND existing_payment_event_id=ANY($3::uuid[])`,
        [propertyId,intent.bookingId,intent.previousEventIds]);
      if (mapped.rows[0].total !== intent.previousEventIds.length)
        throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    }
    if (intent.kind === 'refunded' && !intent.refundOfEventId)
      throw new GateError('REFUND_SOURCE_REQUIRED', 422);
    if (intent.kind === 'received') {
      if (!Number.isSafeInteger(intent.bookingTotalCents) || intent.bookingTotalCents <= 0)
        throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      const net = await client.query(`SELECT COALESCE(sum(CASE
          WHEN e.event_kind='property_refund' THEN -a.amount_cents
          WHEN e.event_kind='reversal' AND original.event_kind='property_refund'
            THEN -a.amount_cents ELSE a.amount_cents END),0)::bigint AS total
        FROM iron_gate.finance_allocation a JOIN iron_gate.finance_event e
          ON e.property_id=a.property_id AND e.id=a.event_id
        LEFT JOIN iron_gate.finance_event original
          ON original.property_id=e.property_id AND original.id=e.reverses_event_id
        WHERE a.property_id=$1 AND a.booking_id=$2 AND a.allocation_kind IN ('room','deposit')
          AND (e.event_kind IN ('property_receipt','property_refund') OR
            (e.event_kind='reversal' AND original.event_kind IN ('property_receipt','property_refund')))`,
        [propertyId,intent.bookingId]);
      if (Number(net.rows[0].total)+intent.amountCents > intent.bookingTotalCents)
        throw new GateError('RECEIPT_EXCEEDS_DUE',409);
      const ambiguous = await client.query(`SELECT 1 FROM iron_gate.finance_allocation a
        JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
        WHERE a.property_id=$1 AND a.booking_id=$2 AND
          e.event_kind IN ('ota_payout','ota_guest_payment_observed') LIMIT 1`,
        [propertyId,intent.bookingId]);
      if (ambiguous.rows.length) throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    }
    const doc = await document(client,propertyId,sourceId,'iron_gate_native',intent.eventId,'money',1);
    await revision(client,propertyId,doc,'create','1',intent.actorRef,intent);
    let original = null;
    if (intent.refundOfEventId) {
      const found = await client.query(`SELECT e.document_id,d.status FROM iron_gate.finance_event e
        JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
        WHERE e.property_id=$1 AND e.id=$2 AND e.event_kind='property_receipt'`,
        [propertyId,intent.refundOfEventId]);
      if (!found.rows.length || found.rows[0].status !== 'active')
        throw new GateError('REFUND_SOURCE_REQUIRED', 422);
      original = found.rows[0].document_id;
    }
    const day = taipeiDay(intent.occurredAt);
    await event(client,propertyId,doc,intent.eventId,
      intent.kind === 'received' ? 'property_receipt' : 'property_refund',
      intent.amountCents,day,intent.actorRef,`ig-payment:${intent.eventId}`,
      intent.method ?? null,original,intent.refundOfEventId ?? null);
    await allocation(client,propertyId,intent.eventId,intent.bookingId,intent.amountCents);
    await client.query(`INSERT INTO iron_gate.finance_payment_ownership
      (id,property_id,provider_code,booking_id,existing_payment_event_id,canonical_document_id)
      VALUES ($1,$2,'iron_gate_native',$3,$4,$5)`,
      [randomUUID(),propertyId,intent.bookingId,intent.eventId,doc.id]);
    response.as_of_change_seq = await appendFinanceChange(client,propertyId,
      'document_revision',doc.id,String(doc.version));
    await linkFinanceEvents(client,propertyId,response.as_of_change_seq,[intent.eventId]);
    await receipt(client,propertyId,sourceId,intent,response);
    return;
  }
  if (intent.type !== 'card') throw new GateError('FINANCE_NATIVE_INTENT_INVALID', 500);
  const sourceId = await connector(client,propertyId,'sweetfun_card');
  if (intent.sourceInstanceId !== sourceId)
    throw new GateError('SOURCE_FORBIDDEN',403);
  const nativeSourceId = await connector(client,propertyId,'iron_gate_native');
  const existing = await client.query(`SELECT current_version FROM iron_gate.finance_document
    WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
    [propertyId,sourceId,intent.bookingId]);
  const nextVersion = existing.rows.length ? Number(existing.rows[0].current_version) + 1 : 1;
  const doc = await document(client,propertyId,sourceId,'sweetfun_card',
    intent.bookingId,'card_result',nextVersion);
  await revision(client,propertyId,doc,intent.paymentEventId ? 'create' : 'card_fail',
    intent.fingerprint,intent.actorRef,intent);
  if (intent.paymentEventId) {
    const day = intent.chargeDate;
    const prior = await client.query(`SELECT 1 FROM iron_gate.finance_allocation a
      JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
      WHERE a.property_id=$1 AND a.booking_id=$2 AND
        e.event_kind IN ('property_receipt','ota_payout','ota_guest_payment_observed') LIMIT 1`,
      [propertyId,intent.bookingId]);
    if (prior.rows.length) throw new GateError('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    await event(client,propertyId,doc,intent.paymentEventId,'property_receipt',
      intent.amountCents,day,intent.actorRef,`card:${intent.fingerprint}`,'credit_card');
    await allocation(client,propertyId,intent.paymentEventId,intent.bookingId,intent.amountCents);
    await client.query(`INSERT INTO iron_gate.finance_source_alias
      (property_id,source_instance_id,source_record_id,canonical_document_id,evidence_ref)
      VALUES ($1,$2,$3,$4,$5)`, [propertyId,nativeSourceId,intent.paymentEventId,
        doc.id,`card:${intent.fingerprint}`]);
    await client.query(`INSERT INTO iron_gate.finance_payment_ownership
      (id,property_id,provider_code,booking_id,existing_payment_event_id,canonical_document_id)
      VALUES ($1,$2,'sweetfun_card',$3,$4,$5)`,
      [randomUUID(),propertyId,intent.bookingId,intent.paymentEventId,doc.id]);
  }
  response.as_of_change_seq = await appendFinanceChange(client,propertyId,
    'document_revision',doc.id,String(doc.version));
  if (intent.paymentEventId) await linkFinanceEvents(client,propertyId,
    response.as_of_change_seq,[intent.paymentEventId]);
  await receipt(client,propertyId,sourceId,intent,response);
}
