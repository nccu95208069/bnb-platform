import { randomUUID } from 'node:crypto';

/**
 * Caller must hold the property's property_state row lock. The lock is shared
 * by the finance API and the native booking transaction, so MAX + 1 is safe.
 */
export async function appendFinanceChange(client, propertyId, kind, sourceId, sourceVersion) {
  const latest = await client.query(`SELECT COALESCE(MAX(change_seq),0)::bigint AS seq
    FROM iron_gate.finance_change WHERE property_id=$1`, [propertyId]);
  const seq = BigInt(latest.rows[0].seq) + 1n;
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('FINANCE_CHANGE_SEQ_OVERFLOW');
  await client.query(`INSERT INTO iron_gate.finance_change
    (property_id,change_seq,source_kind,source_id,source_version)
    VALUES ($1,$2,$3,$4,$5)`, [propertyId,seq.toString(),kind,String(sourceId),String(sourceVersion)]);
  await client.query(`INSERT INTO iron_gate.finance_outbox
    (id,property_id,change_seq,source_kind,source_id,destination)
    VALUES ($1,$2,$3,$4,$5,'sheet')`,
    [randomUUID(),propertyId,seq.toString(),kind,String(sourceId)]);
  return Number(seq);
}

export async function financeWatermark(client, propertyId) {
  const latest = await client.query(`SELECT COALESCE(MAX(change_seq),0)::bigint AS seq
    FROM iron_gate.finance_change WHERE property_id=$1`, [propertyId]);
  const seq = BigInt(latest.rows[0].seq);
  if (seq > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('FINANCE_CHANGE_SEQ_OVERFLOW');
  return Number(seq);
}

export async function linkFinanceEvents(client, propertyId, changeSeq, eventIds) {
  for (const eventId of eventIds) await client.query(`INSERT INTO iron_gate.finance_change_event
    (property_id,change_seq,event_id) VALUES ($1,$2,$3)`,
    [propertyId,changeSeq,eventId]);
}
