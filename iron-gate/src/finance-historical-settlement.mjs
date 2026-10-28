import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const TEXT = /^[A-Za-z0-9._:-]{1,256}$/;
const DECISIONS = new Set(['settled_before_cutover_cash_details_unknown',
  'unpaid_at_cutover']);
const ROW_KEYS = ['booking_id','booking_version','booking_snapshot_hash',
  'booking_total_cents','source_order_key','source_link_snapshot_hash',
  'os_receipt_id','os_receipt_version','os_receipt_snapshot_hash',
  'sheet_row_snapshot_hash','sheet_order_source_version','money_aliases_hash','os_receipt_amount_cents',
  'os_settles_room','decision'];
const MANIFEST_KEYS = ['property_id','source_instance_id','full_os_snapshot_hash',
  'owner_decision_hash','sheet_snapshot_hash','rows'];

function exactKeys(value, keys) {
  return value && !Array.isArray(value) && typeof value === 'object' &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value,key));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function bookingSnapshotHash(booking) {
  return createHash('sha256').update(canonical({
    id: booking.id, version: booking.version, totalCents: booking.totalCents,
    currency: booking.currency, source: booking.source, status: booking.status,
    sourceCalendar: booking.sourceCalendar ?? null,
  })).digest('hex');
}

export function parseHistoricalManifest(bytes, expectedSha256) {
  if (!Buffer.isBuffer(bytes) || !HEX.test(expectedSha256 ?? ''))
    throw Error('HISTORICAL_MANIFEST_INVALID');
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(expectedSha256,'hex');
  if (!timingSafeEqual(actual,expected)) throw Error('HISTORICAL_MANIFEST_HASH_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); }
  catch { throw Error('HISTORICAL_MANIFEST_INVALID'); }
  if (!exactKeys(manifest,MANIFEST_KEYS) || !UUID.test(manifest.property_id) ||
    !UUID.test(manifest.source_instance_id) ||
    !HEX.test(manifest.full_os_snapshot_hash) ||
    !HEX.test(manifest.owner_decision_hash) ||
    !HEX.test(manifest.sheet_snapshot_hash) ||
    !Array.isArray(manifest.rows) || manifest.rows.length !== 4)
    throw Error('HISTORICAL_MANIFEST_INVALID');
  const seenBookings = new Set();
  const seenOrders = new Set();
  const seenReceipts = new Set();
  let settled = 0;
  let unpaid = 0;
  for (const row of manifest.rows) {
    if (!exactKeys(row,ROW_KEYS) || !UUID.test(row.booking_id) ||
      !Number.isSafeInteger(row.booking_version) || row.booking_version < 1 ||
      !Number.isSafeInteger(row.booking_total_cents) || row.booking_total_cents < 1 ||
      !TEXT.test(row.source_order_key) || !TEXT.test(row.os_receipt_id) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(row.os_receipt_version) ||
      !['booking_snapshot_hash','source_link_snapshot_hash','os_receipt_snapshot_hash',
        'sheet_row_snapshot_hash','sheet_order_source_version',
        'money_aliases_hash'].every(key => HEX.test(row[key])) ||
      row.os_receipt_amount_cents !== 0 || row.os_settles_room !== true ||
      !DECISIONS.has(row.decision) || seenBookings.has(row.booking_id) ||
      seenOrders.has(row.source_order_key) || seenReceipts.has(row.os_receipt_id))
      throw Error('HISTORICAL_MANIFEST_INVALID');
    seenBookings.add(row.booking_id);
    seenOrders.add(row.source_order_key);
    seenReceipts.add(row.os_receipt_id);
    if (row.decision === 'unpaid_at_cutover') unpaid++;
    else settled++;
  }
  if (settled !== 3 || unpaid !== 1) throw Error('HISTORICAL_MANIFEST_INVALID');
  return Object.freeze({ ...manifest, rows: Object.freeze(manifest.rows.map(row => Object.freeze(row))),
    sha256:expectedSha256 });
}

export function loadHistoricalManifestFromEnvironment(env = process.env) {
  if (env.IRON_GATE_FINANCE_HISTORICAL_SETTLEMENT_ENABLED !== 'true') return null;
  const path = env.IRON_GATE_FINANCE_HISTORICAL_MANIFEST_PATH;
  const sha = env.IRON_GATE_FINANCE_HISTORICAL_MANIFEST_SHA256;
  if (!path || !sha) throw Error('HISTORICAL_MANIFEST_NOT_CONFIGURED');
  return parseHistoricalManifest(readFileSync(path),sha);
}

export function historicalSettlementProjection(disposition, booking, baselineRemaining,
  cashEventCount, legacyPaymentReviewRequired) {
  if (!disposition) return { legacy_settlement:null,
    historical_cash_detail_missing:false,collection_hold:false,
    remaining_due_cents:baselineRemaining,review_required:false };
  const settled = disposition.decision === 'settled_before_cutover_cash_details_unknown';
  const changed = Number(disposition.booking_version) !== booking.version ||
    Number(disposition.booking_total_cents) !== booking.totalCents ||
    disposition.booking_snapshot_hash !== bookingSnapshotHash(booking);
  const conflict = changed || legacyPaymentReviewRequired ||
    (!settled && baselineRemaining === null) ||
    (settled && cashEventCount > 0);
  return { legacy_settlement:{ id:disposition.id,status:disposition.decision,
      booking_version:Number(disposition.booking_version),
      booking_total_cents:Number(disposition.booking_total_cents),
      cash_effect_cents:0,collection_hold:settled,
      historical_cash_detail_missing:settled,review_required:conflict },
    historical_cash_detail_missing:settled,
    collection_hold:settled,
    remaining_due_cents:conflict ? null : settled ? 0 : baselineRemaining,
    review_required:conflict };
}
