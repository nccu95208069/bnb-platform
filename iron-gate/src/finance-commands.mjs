import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GateError } from './errors.ts';
import { appendFinanceChange, financeWatermark, linkFinanceEvents } from './finance-change.mjs';
import { validSourceRecordedAt } from './finance-source-time.mjs';
import { bookingSnapshotHash, historicalSettlementProjection } from './finance-historical-settlement.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_AMOUNT = 1_000_000_000_000;
const KINDS = new Set(['property_receipt', 'property_refund', 'ota_guest_payment_observed',
  'ota_payout', 'expense_paid', 'processor_fee_paid']);
const LEVELS = new Set(['operator_attested', 'provider_notice', 'processor_confirmed', 'bank_reconciled']);
const ALLOCATION_KINDS = new Set(['room', 'deposit', 'extra', 'ota_payout', 'expense']);
const POLICY = new Set(['line_v1_last_month_whole_twd', 'os_source_exact', 'ig_v1_earliest_cent']);
const METHODS = new Set(['cash','bank_transfer','credit_card','other']);
const ACTIONS = new Set(['create', 'amend', 'void']);
const COMMAND_KEYS = new Set(['request_key', 'source_record_id', 'source_version', 'expected_version',
  'origin_request_hash',
  'action', 'event_kind', 'amount_cents', 'currency', 'effective_on', 'cash_on', 'service_on',
  'category_code', 'receipt_purpose', 'payment_method_code', 'payment_account_ref',
  'advanced_by_ref','advanced_by_kind','advanced_by_label',
  'safe_description', 'evidence_level', 'evidence_ref',
  'booking_allocations', 'booking_guards', 'expense_attributions', 'related_receipt_document_id',
  'related_receipt_event_id', 'reason_code', 'reason_note',
  'preview_token','provider_transaction_ref','source_actor_ref','source_recorded_at']);

function fail(code, status = 400) { throw new GateError(code, status); }
function safeText(value, max, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || (required && !value) || value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_INPUT');
  return value;
}
function day(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !DAY.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail('INVALID_DATE');
  return value;
}
function money(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT) fail('INVALID_AMOUNT');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function assertGeneralEntryCommand(principal, command) {
  if (principal.financeGeneralEntriesOnly !== true) return;
  if (command.booking_allocations.length || command.booking_guards.length)
    fail('SOURCE_FORBIDDEN',403);
  if (command.action === 'void') return;
  if (command.event_kind === 'property_receipt' &&
    command.receipt_purpose === 'other') return;
  if (command.event_kind === 'expense_paid' &&
    command.receipt_purpose == null) return;
  fail('SOURCE_FORBIDDEN',403);
}
function assertImportCatalogProvenance(raw) {
  if (!HEX.test(raw?.origin_request_hash ?? '') ||
    typeof raw?.origin_source_version !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(raw?.origin_source_version ?? '') ||
    typeof raw?.source_actor_ref !== 'string' ||
    !/^os_actor:[0-9a-f]{64}$/.test(raw?.source_actor_ref ?? '') ||
    !validSourceRecordedAt(raw?.source_recorded_at)) fail('INVALID_INPUT');
}
function operationChange(raw, response, requestKey, sourceInstanceId) {
  if (response.status_id) return ['operational_status', response.status_id, raw.version];
  if (response.rule_id) return ['recurring_rule', response.rule_id, raw.version];
  if (response.platform) return ['payout_rule', response.platform, raw.version];
  if (response.assertion_id) return ['evidence_assertion', response.assertion_id, '1'];
  if (response.settlement_id) return ['settlement', response.settlement_id, '1'];
  if (response.source_order_key) return ['source_link',
    `${sourceInstanceId}:${response.source_order_key}`, requestKey];
  if (response.issue_id) return ['import_issue', response.issue_id, requestKey];
  if (response.account_code) return ['payment_account', response.account_code, requestKey];
  if (response.category_code) return ['category',
    `${raw.kind}:${response.category_code}`, requestKey];
  throw Error('FINANCE_CHANGE_SOURCE_MISSING');
}
function base64(value) { return Buffer.from(value).toString('base64url'); }
function pgDay(value) {
  // node-postgres parses a SQL date at local midnight. UTC formatting can
  // move it into the preceding calendar day in Asia/Taipei.
  if (!(value instanceof Date)) return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function todayTaipei() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Taipei',
    year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  return `${parts.find(p => p.type==='year').value}-${parts.find(p => p.type==='month').value}-${parts.find(p => p.type==='day').value}`;
}
function normalize(raw, requestKey) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object' ||
    Object.keys(raw).some(key => !COMMAND_KEYS.has(key))) fail('INVALID_INPUT');
  if (safeText(raw.request_key, 256, true) !== requestKey) fail('INVALID_INPUT');
  const action = safeText(raw.action, 16, true);
  if (!ACTIONS.has(action)) fail('INVALID_INPUT');
  const eventKind = action === 'void' ? null : safeText(raw.event_kind, 48, true);
  if (eventKind && !KINDS.has(eventKind)) fail('INVALID_INPUT');
  if (action !== 'create' && (!Number.isSafeInteger(raw.expected_version) || raw.expected_version < 1))
    fail('INVALID_INPUT');
  if (action === 'create' && raw.expected_version != null) fail('INVALID_INPUT');
  if (raw.currency != null && raw.currency !== 'TWD') fail('UNSUPPORTED_CURRENCY', 422);
  if (action !== 'void' && raw.currency !== 'TWD') fail('UNSUPPORTED_CURRENCY', 422);
  if (raw.source_version == null || !/^[A-Za-z0-9._:-]{1,128}$/.test(String(raw.source_version)))
    fail('INVALID_INPUT');
  if (raw.origin_request_hash != null && !HEX.test(raw.origin_request_hash))
    fail('INVALID_INPUT');
  if (raw.source_recorded_at != null && !validSourceRecordedAt(raw.source_recorded_at))
    fail('INVALID_SOURCE_TIMESTAMP',422);
  const allocations = raw.booking_allocations ?? [];
  if (!Array.isArray(allocations) || allocations.length > 100 || allocations.some(a =>
    !a || !UUID.test(a.booking_id) || !Number.isSafeInteger(a.expected_booking_version) ||
    a.expected_booking_version < 1 || !ALLOCATION_KINDS.has(a.allocation_kind) ||
    !Number.isSafeInteger(a.amount_cents) || a.amount_cents <= 0 || a.amount_cents > MAX_AMOUNT ||
    (a.source_order_key != null && (typeof a.source_order_key !== 'string' ||
      a.source_order_key.length < 1 || a.source_order_key.length > 256)) ||
    (a.source_order_key != null && !HEX.test(a.source_snapshot_hash)) ||
    Object.keys(a).some(key => !['booking_id','expected_booking_version','amount_cents',
      'allocation_kind','source_order_key','source_snapshot_hash'].includes(key))))
    fail('INVALID_INPUT');
  if (new Set(allocations.map(a => `${a.booking_id}:${a.allocation_kind}`)).size !== allocations.length)
    fail('ALLOCATION_MISMATCH', 422);
  const guards = raw.booking_guards ?? [];
  if (!Array.isArray(guards) || guards.length > 100 ||
    (action !== 'void' && guards.length) || guards.some(g => !g ||
      !UUID.test(g.booking_id) || !Number.isSafeInteger(g.expected_booking_version) ||
      g.expected_booking_version < 1 ||
      Object.keys(g).some(key => !['booking_id','expected_booking_version'].includes(key))) ||
    new Set(guards.map(g => g.booking_id)).size !== guards.length) fail('INVALID_INPUT');
  const attributions = raw.expense_attributions ?? [];
  if (!Array.isArray(attributions) || attributions.length > 120 || attributions.some(a =>
    !a || !DAY.test(a.month) || !a.month.endsWith('-01') ||
    Number.isNaN(Date.parse(`${a.month}T00:00:00Z`)) ||
    new Date(`${a.month}T00:00:00Z`).toISOString().slice(0,10) !== a.month ||
    !POLICY.has(a.allocation_policy) ||
    !Number.isSafeInteger(a.amount_cents) || a.amount_cents <= 0 || a.amount_cents > MAX_AMOUNT ||
    Object.keys(a).some(key => !['month','amount_cents','allocation_policy'].includes(key))))
    fail('INVALID_INPUT');
  if (new Set(attributions.map(a => a.month)).size !== attributions.length)
    fail('ALLOCATION_MISMATCH', 422);
  const amount = action === 'void' ? null : money(raw.amount_cents);
  const expense = ['expense_paid', 'processor_fee_paid'].includes(eventKind);
  if (action !== 'void' && (allocations.reduce((n, a) => n + a.amount_cents, 0) > amount ||
    (expense && attributions.reduce((n, a) => n + a.amount_cents, 0) !== amount) ||
    (!expense && attributions.length) ||
    (['ota_payout', 'ota_guest_payment_observed'].includes(eventKind) &&
      allocations.reduce((n, a) => n + a.amount_cents, 0) !== amount) ||
    (eventKind === 'property_receipt' && allocations.some(a =>
      ['room', 'deposit'].includes(a.allocation_kind)) &&
      allocations.reduce((n, a) => n + a.amount_cents, 0) !== amount)))
    fail('ALLOCATION_MISMATCH', 422);
  if (eventKind === 'property_refund' &&
    allocations.reduce((n, a) => n + a.amount_cents, 0) !== amount)
    fail('ALLOCATION_MISMATCH', 422);
  if (action !== 'void' &&
    ((expense && !safeText(raw.category_code, 64, true)) ||
      (!expense && eventKind !== 'property_receipt' && raw.category_code != null) ||
      (raw.category_code != null &&
        !/^[a-z][a-z0-9_]{0,63}$/.test(raw.category_code)))) fail('INVALID_INPUT');
  if (eventKind === 'property_receipt' && !['room', 'deposit', 'extra', 'other'].includes(raw.receipt_purpose))
    fail('INVALID_INPUT');
  if (eventKind === 'property_receipt' && ['room', 'deposit', 'extra'].includes(raw.receipt_purpose) &&
    allocations.reduce((n, a) => n + a.amount_cents, 0) !== amount) fail('ALLOCATION_MISMATCH', 422);
  if (eventKind === 'property_receipt' && allocations.some(a =>
    ['room','deposit','extra'].includes(raw.receipt_purpose) ?
      a.allocation_kind !== raw.receipt_purpose : a.allocation_kind === 'expense'))
    fail('ALLOCATION_MISMATCH', 422);
  if (['ota_payout','ota_guest_payment_observed'].includes(eventKind) &&
    allocations.some(a => a.allocation_kind !== 'ota_payout')) fail('ALLOCATION_MISMATCH', 422);
  if (expense && allocations.some(a => a.allocation_kind !== 'expense'))
    fail('ALLOCATION_MISMATCH', 422);
  if (eventKind === 'property_receipt' && raw.receipt_purpose === 'other' &&
    allocations.length && allocations.reduce((n,a) => n + a.amount_cents, 0) !== amount)
    fail('ALLOCATION_MISMATCH', 422);
  if (action !== 'void' && eventKind !== 'ota_guest_payment_observed' && !day(raw.cash_on, true))
    fail('INVALID_DATE');
  if (eventKind === 'ota_guest_payment_observed' && raw.cash_on != null) fail('INVALID_INPUT');
  if (eventKind === 'property_refund' && (!UUID.test(raw.related_receipt_document_id) ||
    !UUID.test(raw.related_receipt_event_id))) fail('INVALID_INPUT');
  if (eventKind !== 'property_refund' && (raw.related_receipt_document_id != null ||
    raw.related_receipt_event_id != null)) fail('INVALID_INPUT');
  if (action === 'void' && (raw.amount_cents != null || raw.event_kind != null ||
    allocations.length || attributions.length)) fail('INVALID_INPUT');
  const level = action === 'void' ? null : safeText(raw.evidence_level, 32, true);
  if (level && !LEVELS.has(level)) fail('INVALID_INPUT');
  if (raw.payment_method_code != null && !METHODS.has(raw.payment_method_code))
    fail('INVALID_INPUT');
  if (raw.provider_transaction_ref != null &&
    (action === 'void' || eventKind !== 'property_receipt' ||
      allocations.length !== 1 || !raw.payment_method_code)) fail('INVALID_INPUT');
  const command = {
    request_key: requestKey, source_record_id: safeText(raw.source_record_id, 256, true),
    origin_request_hash: raw.origin_request_hash ?? null,
    source_version: String(raw.source_version), expected_version: raw.expected_version ?? null,
    action, event_kind: eventKind, amount_cents: amount, currency: action === 'void' ? null : 'TWD',
    effective_on: action === 'void' ? null : day(raw.effective_on, true),
    cash_on: action === 'void' ? null : day(raw.cash_on),
    service_on: action === 'void' ? null : day(raw.service_on),
    category_code: safeText(raw.category_code, 64),
    receipt_purpose: safeText(raw.receipt_purpose, 32),
    payment_method_code: safeText(raw.payment_method_code, 64),
    payment_account_ref: safeText(raw.payment_account_ref, 64),
    advanced_by_ref: safeText(raw.advanced_by_ref, 128),
    advanced_by_kind: safeText(raw.advanced_by_kind, 16),
    advanced_by_label: safeText(raw.advanced_by_label, 100),
    safe_description: safeText(raw.safe_description, 500),
    evidence_level: level, evidence_ref: safeText(raw.evidence_ref, 256),
    booking_allocations: allocations, booking_guards: guards,
    expense_attributions: attributions,
    related_receipt_document_id: raw.related_receipt_document_id ?? null,
    related_receipt_event_id: raw.related_receipt_event_id ?? null,
    provider_transaction_ref: safeText(raw.provider_transaction_ref,128),
    // Absence must preserve the pre-016 command hash for old request-key retries.
    ...(raw.source_actor_ref == null ? {} :
      { source_actor_ref: safeText(raw.source_actor_ref,128,true) }),
    // Omission preserves the original command hash for existing request-key retries.
    ...(raw.source_recorded_at == null ? {} :
      { source_recorded_at: raw.source_recorded_at }),
    reason_code: safeText(raw.reason_code, 64),
    reason_note: safeText(raw.reason_note, 300),
  };
  if (action === 'create' && command.reason_note != null) fail('INVALID_INPUT');
  if ((command.advanced_by_ref == null) !== (command.advanced_by_kind == null) ||
    (command.advanced_by_ref == null) !== (command.advanced_by_label == null) ||
    command.advanced_by_kind != null &&
      (!['self','account','other'].includes(command.advanced_by_kind) ||
        !command.advanced_by_label?.trim() || !expense)) fail('INVALID_INPUT');
  if (command.safe_description && /(?:\d[ -]?){13,19}|@|\+?\d{9,}/.test(command.safe_description))
    fail('UNSAFE_DESCRIPTION', 422);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(command.source_record_id) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(command.request_key)) fail('INVALID_INPUT');
  for (const opaque of [command.evidence_ref, command.advanced_by_ref,
    command.provider_transaction_ref,command.source_actor_ref])
    if (opaque != null && (!/^[A-Za-z0-9._:-]{1,256}$/.test(opaque) ||
      /\d{13,19}/.test(opaque))) fail('INVALID_INPUT');
  return command;
}

export class FinanceCommandService {
  #pool; #secret; #enabled; #historicalManifest;
  constructor(pool, secret, enabled = false, historicalManifest = null) {
    this.#pool = pool;
    this.#secret = secret;
    this.#enabled = enabled && typeof secret === 'string' && secret.length >= 32;
    this.#historicalManifest = historicalManifest;
  }
  get enabled() { return this.#enabled; }
  #authorize(principal, propertyId, action) {
    if (!principal.propertyIds?.includes(propertyId) || !principal.actions?.includes(action))
      fail('PROPERTY_FORBIDDEN', 403);
    if (!UUID.test(principal.financeSourceInstanceId ?? '')) fail('SOURCE_FORBIDDEN', 403);
    if (typeof principal.subjectId !== 'string' || !principal.subjectId ||
      principal.subjectId.length > 128) fail('SOURCE_FORBIDDEN', 403);
    if (!this.#enabled) fail('FINANCE_COMMANDS_DISABLED', 503);
  }
  async #transaction(propertyId, write, fn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query(write ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' :
          'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [propertyId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '23505' && error.constraint === 'finance_payment_transaction_unique')
          fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        if (write && ['40001', '40P01'].includes(error.code) && attempt < 2) continue;
        throw error;
      } finally { client.release(); }
    }
  }
  async #context(client, principal, propertyId, write, shadowImport = false) {
    const stateResult = await client.query(`SELECT state_json, workspace_id, authority_epoch
      FROM iron_gate.property_state WHERE property_id=$1 ${write ? 'FOR UPDATE' : ''}`, [propertyId]);
    const row = stateResult.rows[0];
    if (!row || row.workspace_id !== principal.workspaceId) fail('PROPERTY_FORBIDDEN', 403);
    if (write && (Number(row.authority_epoch) !== principal.authorityEpoch || row.state_json.readOnly))
      fail('AUTHORITY_MOVED', 409);
    const connector = await client.query(`SELECT source_system,source_account_ref,
      source_sheet_ref,enabled,cutover_at
      FROM iron_gate.finance_connector WHERE property_id=$1 AND source_instance_id=$2`,
      [propertyId, principal.financeSourceInstanceId]);
    const source = connector.rows[0];
    const originAllowed = shadowImport ? principal.origin === 'finance' &&
      principal.actions.includes('finance:import') &&
      ['os_manual','os_legacy_payment','line_finance'].includes(source?.source_system) &&
      (!write || !source?.cutover_at) : principal.origin === 'os' ?
      ['os_manual','sheet_bulk'].includes(source?.source_system) :
      principal.origin === 'line' ? source?.source_system === 'line_finance' :
      principal.origin === 'finance' ? ['sheet_bulk','ota_evidence'].includes(source?.source_system) : false;
    const generalSourceAllowed = principal.financeGeneralEntriesOnly !== true ||
      (principal.origin === 'os' && source?.source_system === 'os_manual') ||
      (principal.origin === 'line' && source?.source_system === 'line_finance');
    if (!source || !source.enabled || !originAllowed || !generalSourceAllowed ||
      (write && (!source.cutover_at ||
      Date.parse(source.cutover_at) > Date.now()) && !shadowImport))
      fail('SOURCE_FORBIDDEN', 403);
    return { state: row.state_json, source };
  }
  #token(principal, propertyId, command, bookings) {
    const claims = { propertyId, sourceInstanceId: principal.financeSourceInstanceId,
      subjectId: principal.subjectId, commandHash: hash(command), bookings,
      expiresAt: Date.now() + 15 * 60_000 };
    const payload = base64(JSON.stringify(claims));
    const mac = createHmac('sha256', this.#secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }
  #verifyToken(token, principal, propertyId, command, bookings) {
    if (typeof token !== 'string' || token.length > 8192) fail('VERSION_CONFLICT', 409);
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) fail('VERSION_CONFLICT', 409);
    const expected = createHmac('sha256', this.#secret).update(match[1]).digest();
    const actual = Buffer.from(match[2], 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      fail('VERSION_CONFLICT', 409);
    let claims;
    try { claims = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); }
    catch { fail('VERSION_CONFLICT', 409); }
    if (claims.propertyId !== propertyId ||
      claims.sourceInstanceId !== principal.financeSourceInstanceId ||
      claims.subjectId !== principal.subjectId || claims.commandHash !== hash(command) ||
      claims.expiresAt < Date.now() || canonical(claims.bookings) !== canonical(bookings))
      fail('VERSION_CONFLICT', 409);
  }
  #bookings(state, command) {
    return (command.action === 'void' ? command.booking_guards : command.booking_allocations).map(a => {
      const booking = state.bookings.find(b => b.id === a.booking_id);
      if (!booking || booking.propertyId !== state.propertyId) fail('UNKNOWN_BOOKING', 422);
      if (booking.version !== a.expected_booking_version) fail('VERSION_CONFLICT', 409);
      if (command.action !== 'void' && booking.status !== 'confirmed' &&
        !(command.event_kind === 'property_refund' && booking.status === 'cancelled'))
        fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
      return { bookingId: booking.id, version: booking.version, snapshotHash: hash({
        id: booking.id, version: booking.version, totalCents: booking.totalCents,
        currency: booking.currency, source: booking.source, status: booking.status,
        sourceCalendar: booking.sourceCalendar ?? null,
      }) };
    });
  }
  async #assertLegacyPaymentsMapped(client, propertyId, booking) {
    const events = booking.paymentEvents ?? [];
    const cardResults = booking.cardChargeResults ?? [];
    if (!Array.isArray(events) || !Array.isArray(cardResults)) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    const ids = events.map(event => event?.id);
    if (ids.some(id => !UUID.test(id ?? '')) || new Set(ids).size !== ids.length)
      fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    const doneIds = cardResults.filter(result =>
      String(result?.status).toLowerCase() === 'done').map(result => result.paymentEventId);
    if (doneIds.some(id => !UUID.test(id ?? '') || !ids.includes(id)))
      fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    if (!ids.length) return;
    const mapped = await client.query(`SELECT o.existing_payment_event_id,o.provider_code
      FROM iron_gate.finance_payment_ownership o
      JOIN iron_gate.finance_document d ON d.property_id=o.property_id
        AND d.id=o.canonical_document_id
      WHERE o.property_id=$1 AND o.booking_id=$2
        AND o.existing_payment_event_id=ANY($3::uuid[]) AND d.status='active'
        AND EXISTS (SELECT 1 FROM iron_gate.finance_event e
          JOIN iron_gate.finance_allocation a ON a.property_id=e.property_id
            AND a.event_id=e.id
          WHERE e.property_id=d.property_id AND e.document_id=d.id
            AND e.event_kind IN ('property_receipt','property_refund')
            AND a.booking_id=o.booking_id)`,
      [propertyId,booking.id,ids]);
    const owned = new Map(mapped.rows.map(row => [row.existing_payment_event_id,row.provider_code]));
    if (owned.size !== ids.length || doneIds.some(id => owned.get(id) !== 'sweetfun_card'))
      fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
  }
  async #assertVoidGuards(client, principal, propertyId, command) {
    if (command.action !== 'void') return;
    const rows = await client.query(`SELECT d.id FROM iron_gate.finance_document d
      WHERE d.property_id=$1 AND d.source_instance_id=$2 AND d.source_record_id=$3
        AND d.current_version=$4 AND d.status='active'`,
      [propertyId,principal.financeSourceInstanceId,command.source_record_id,
        command.expected_version]);
    if (rows.rows.length !== 1) fail('VERSION_CONFLICT',409);
    const allocations = await client.query(`SELECT DISTINCT a.booking_id
      FROM iron_gate.finance_allocation a JOIN iron_gate.finance_event e
        ON e.property_id=a.property_id AND e.id=a.event_id
      WHERE e.property_id=$1 AND e.document_id=$2 AND e.revision_version=$3
        AND e.event_kind<>'reversal'`,
      [propertyId,rows.rows[0].id,command.expected_version]);
    const actual = allocations.rows.map(row => row.booking_id).sort();
    const requested = command.booking_guards.map(g => g.booking_id).sort();
    if (canonical(actual) !== canonical(requested)) fail('VERSION_CONFLICT',409);
  }
  async #assertGeneralDocument(client, principal, propertyId, command) {
    if (principal.financeGeneralEntriesOnly !== true || command.action === 'create') return;
    const result = await client.query(`SELECT d.current_version,d.status,
      e.event_kind,e.receipt_purpose,
      EXISTS (SELECT 1 FROM iron_gate.finance_allocation a
        JOIN iron_gate.finance_event prior ON prior.property_id=a.property_id
          AND prior.id=a.event_id
        WHERE prior.property_id=d.property_id AND prior.document_id=d.id) AS ever_allocated
      FROM iron_gate.finance_document d
      JOIN iron_gate.finance_event e ON e.property_id=d.property_id
        AND e.document_id=d.id AND e.revision_version=d.current_version
        AND e.event_kind<>'reversal'
      WHERE d.property_id=$1 AND d.source_instance_id=$2 AND d.source_record_id=$3`,
      [propertyId,principal.financeSourceInstanceId,command.source_record_id]);
    if (result.rows.length !== 1 || result.rows[0].status !== 'active' ||
      result.rows[0].current_version !== command.expected_version)
      fail('VERSION_CONFLICT',409);
    const prior = result.rows[0];
    if (prior.ever_allocated || !((prior.event_kind === 'property_receipt' &&
      prior.receipt_purpose === 'other') ||
      (prior.event_kind === 'expense_paid' && prior.receipt_purpose == null)))
      fail('SOURCE_FORBIDDEN',403);
  }
  async preview(principal, propertyId, raw, requestKey, shadowImport = false) {
    this.#authorize(principal, propertyId, shadowImport ? 'finance:import' : 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      const { state, source } = await this.#context(client, principal, propertyId, false, shadowImport);
      if (shadowImport && source.cutover_at) fail('SOURCE_FORBIDDEN',403);
      const resolved = structuredClone(raw);
      if (Array.isArray(resolved?.booking_allocations)) {
        for (const a of resolved.booking_allocations) {
          if (a?.source_order_key == null || a.booking_id != null) continue;
          if (typeof a.source_order_key !== 'string' || a.source_order_key.length < 1 ||
            a.source_order_key.length > 256) fail('INVALID_INPUT');
          const linked = await client.query(`SELECT booking_id,verified_booking_version,source_snapshot_hash
            FROM iron_gate.finance_source_link WHERE property_id=$1 AND source_instance_id=$2
              AND source_order_key=$3`,
            [propertyId,principal.financeSourceInstanceId,a.source_order_key]);
          if (linked.rows.length !== 1) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
          const booking = state.bookings.find(b => b.id === linked.rows[0].booking_id);
          if (!booking || booking.version !== Number(linked.rows[0].verified_booking_version))
            fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
          a.booking_id = booking.id;
          a.expected_booking_version = booking.version;
          a.source_snapshot_hash = linked.rows[0].source_snapshot_hash;
        }
      }
      const command = normalize(resolved, requestKey);
      if (!shadowImport) {
        assertGeneralEntryCommand(principal,command);
        await this.#assertGeneralDocument(client,principal,propertyId,command);
      }
      if (shadowImport && !command.source_recorded_at)
        fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      if (!shadowImport && command.source_recorded_at) fail('INVALID_INPUT');
      if (source.source_system === 'sheet_bulk' &&
        (!source.source_sheet_ref || !command.source_record_id.startsWith(
          `sheet:${source.source_sheet_ref}:`) || !UUID.test(command.source_record_id.slice(
            `sheet:${source.source_sheet_ref}:`.length)))) fail('SOURCE_FORBIDDEN',403);
      await this.#assertVoidGuards(client,principal,propertyId,command);
      const bookings = this.#bookings(state, command);
      return { bookings, preview_token: bookings.length ? this.#token(principal, propertyId, command, bookings) : null,
        command_hash: hash(command), resolved_command: command,
        source_instance_id: principal.financeSourceInstanceId,
        source_system: source.source_system, source_sheet_ref: source.source_sheet_ref ?? null };
    });
  }
  async importPreview(principal, propertyId, raw, requestKey) {
    return this.preview(principal,propertyId,raw,requestKey,true);
  }
  async importCommand(principal, propertyId, raw, requestKey) {
    return this.command(principal,propertyId,raw,requestKey,true);
  }
  async receipt(principal, propertyId, requestKey, shadowImport = false) {
    this.#authorize(principal, propertyId, shadowImport ? 'finance:import' : 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      await this.#context(client, principal, propertyId, false, shadowImport);
      const result = await client.query(`SELECT response_json FROM iron_gate.finance_request_receipt
        WHERE property_id=$1 AND source_instance_id=$2 AND request_key=$3`,
        [propertyId, principal.financeSourceInstanceId, requestKey]);
      if (!result.rows.length) fail('REQUEST_NOT_FOUND', 404);
      return result.rows[0].response_json;
    });
  }
  async importReceipt(principal, propertyId, requestKey) {
    return this.receipt(principal,propertyId,requestKey,true);
  }
  #historicalInput(raw, requestKey, commit = false) {
    const keys = new Set(['request_key','booking_id','source_order_key',
      'decision','manifest_sha256',...(commit ? ['preview_token'] : [])]);
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' ||
      Object.keys(raw).length !== keys.size ||
      Object.keys(raw).some(key => !keys.has(key)) ||
      raw.request_key !== requestKey || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestKey) ||
      !UUID.test(raw.booking_id ?? '') ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.source_order_key ?? '') ||
      !['settled_before_cutover_cash_details_unknown','unpaid_at_cutover'].includes(raw.decision) ||
      !HEX.test(raw.manifest_sha256 ?? '') ||
      (commit && typeof raw.preview_token !== 'string')) fail('INVALID_INPUT');
    const { preview_token, ...command } = raw;
    void preview_token;
    return command;
  }
  #historicalRow(principal, propertyId, command) {
    const manifest = this.#historicalManifest;
    if (!manifest || manifest.property_id !== propertyId ||
      manifest.source_instance_id !== principal.financeSourceInstanceId ||
      manifest.sha256 !== command.manifest_sha256) fail('HISTORICAL_MANIFEST_FORBIDDEN',403);
    const row = manifest.rows.find(item => item.booking_id === command.booking_id);
    if (!row || row.source_order_key !== command.source_order_key ||
      row.decision !== command.decision) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    return row;
  }
  async #historicalGuards(client, principal, propertyId, state, source, command, row) {
    if (source.cutover_at || !['os_manual','os_legacy_payment'].includes(source.source_system))
      fail('SOURCE_FORBIDDEN',403);
    const booking = state.bookings.find(item => item.id === row.booking_id);
    if (!booking || booking.propertyId !== propertyId ||
      !['os','external'].includes(booking.source) ||
      booking.status !== 'confirmed' || booking.currency !== 'TWD' ||
      booking.version !== row.booking_version ||
      booking.totalCents !== row.booking_total_cents ||
      bookingSnapshotHash(booking) !== row.booking_snapshot_hash)
      fail('VERSION_CONFLICT',409);
    if (!Array.isArray(booking.paymentEvents) || booking.paymentEvents.length ||
      !Array.isArray(booking.cardChargeResults ?? []) ||
      (booking.cardChargeResults ?? []).some(result =>
        String(result?.status ?? '').toLowerCase() === 'done'))
      fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    const link = await client.query(`SELECT 1 FROM iron_gate.finance_source_link
      WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3
        AND booking_id=$4 AND verified_booking_version=$5 AND source_snapshot_hash=$6`,
      [propertyId,principal.financeSourceInstanceId,row.source_order_key,row.booking_id,
        row.booking_version,row.source_link_snapshot_hash]);
    if (link.rows.length !== 1) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    const otherLinks = await client.query(`SELECT 1 FROM iron_gate.finance_source_link
      WHERE property_id=$1 AND source_instance_id=$2 AND booking_id=$3
        AND source_order_key<>$4 LIMIT 1`,
      [propertyId,principal.financeSourceInstanceId,row.booking_id,row.source_order_key]);
    if (otherLinks.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    const overlapping = await client.query(`SELECT 1 FROM iron_gate.finance_allocation a
      JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
      WHERE a.property_id=$1 AND a.booking_id=$2 LIMIT 1`,[propertyId,row.booking_id]);
    const ownership = await client.query(`SELECT 1 FROM iron_gate.finance_payment_ownership
      WHERE property_id=$1 AND booking_id=$2 LIMIT 1`,[propertyId,row.booking_id]);
    const aliases = await client.query(`SELECT 1 FROM iron_gate.finance_source_alias
      WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3 LIMIT 1`,
      [propertyId,principal.financeSourceInstanceId,row.os_receipt_id]);
    const document = await client.query(`SELECT 1 FROM iron_gate.finance_document
      WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3 LIMIT 1`,
      [propertyId,principal.financeSourceInstanceId,row.os_receipt_id]);
    const openIssue = await client.query(`SELECT 1 FROM iron_gate.finance_import_issue
      WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3
        AND status='open' LIMIT 1`,
      [propertyId,principal.financeSourceInstanceId,row.os_receipt_id]);
    const acceptedStatus = row.decision === 'unpaid_at_cutover' ?
      await client.query(`SELECT 1 FROM iron_gate.finance_operational_status
        WHERE property_id=$1 AND booking_id=$2 AND settles_room=true LIMIT 1`,
        [propertyId,row.booking_id]) : {rows:[]};
    const existing = await client.query(`SELECT 1 FROM iron_gate.finance_legacy_settlement
      WHERE property_id=$1 AND (booking_id=$2 OR
        (source_instance_id=$3 AND (source_order_key=$4 OR os_receipt_id=$5))) LIMIT 1`,
      [propertyId,row.booking_id,principal.financeSourceInstanceId,row.source_order_key,
        row.os_receipt_id]);
    // Pre-cutover requires a drained property-wide Sheet outbox. Even an
    // unrelated unresolved row makes the external Sheet snapshot uncertain.
    const sheetSync = await client.query(`SELECT 1 FROM iron_gate.finance_outbox
      WHERE property_id=$1 AND destination='sheet' AND status<>'delivered' LIMIT 1`,
      [propertyId]);
    if (overlapping.rows.length || ownership.rows.length || aliases.rows.length ||
      document.rows.length || openIssue.rows.length || acceptedStatus.rows.length ||
      existing.rows.length || sheetSync.rows.length)
      fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
    return [{ bookingId:booking.id,version:booking.version,
      snapshotHash:row.booking_snapshot_hash }];
  }
  async historicalSettlementPreview(principal, propertyId, raw, requestKey) {
    this.#authorize(principal,propertyId,'finance:import');
    if (principal.origin !== 'finance') fail('SOURCE_FORBIDDEN',403);
    const command = this.#historicalInput(raw,requestKey);
    const row = this.#historicalRow(principal,propertyId,command);
    return this.#transaction(propertyId,false,async client => {
      const {state,source}=await this.#context(client,principal,propertyId,false,true);
      const bookings=await this.#historicalGuards(client,principal,propertyId,
        state,source,command,row);
      return { request_key:requestKey,booking_id:row.booking_id,decision:row.decision,
        cash_effect_cents:0,manifest_sha256:command.manifest_sha256,
        preview_token:this.#token(principal,propertyId,command,bookings) };
    });
  }
  async historicalSettlementCommit(principal, propertyId, raw, requestKey) {
    this.#authorize(principal,propertyId,'finance:import');
    if (principal.origin !== 'finance') fail('SOURCE_FORBIDDEN',403);
    const command = this.#historicalInput(raw,requestKey,true);
    const row = this.#historicalRow(principal,propertyId,command);
    const requestHash=hash({operation:'historical_settlement',...command});
    return this.#transaction(propertyId,true,async client => {
      const {state,source}=await this.#context(client,principal,propertyId,true,true);
      const previous=await client.query(`SELECT request_hash,response_json
        FROM iron_gate.finance_request_receipt WHERE property_id=$1 AND source_instance_id=$2
          AND request_key=$3`,[propertyId,principal.financeSourceInstanceId,requestKey]);
      if (previous.rows.length) {
        if (previous.rows[0].request_hash!==requestHash) fail('REQUEST_KEY_REUSED',409);
        return previous.rows[0].response_json;
      }
      const bookings=await this.#historicalGuards(client,principal,propertyId,
        state,source,command,row);
      this.#verifyToken(raw.preview_token,principal,propertyId,command,bookings);
      const id=randomUUID();
      await client.query(`INSERT INTO iron_gate.finance_legacy_settlement
        (id,property_id,source_instance_id,booking_id,booking_version,
         booking_snapshot_hash,booking_total_cents,source_order_key,
         source_link_snapshot_hash,os_receipt_id,os_receipt_version,
         os_receipt_snapshot_hash,os_receipt_amount_cents,os_settles_room,
         full_os_snapshot_hash,owner_decision_hash,
         sheet_snapshot_hash,sheet_row_snapshot_hash,sheet_order_source_version,
         money_aliases_hash,
         manifest_sha256,decision,request_key,reviewed_by_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
        [id,propertyId,principal.financeSourceInstanceId,row.booking_id,row.booking_version,
          row.booking_snapshot_hash,row.booking_total_cents,row.source_order_key,
          row.source_link_snapshot_hash,row.os_receipt_id,row.os_receipt_version,
          row.os_receipt_snapshot_hash,row.os_receipt_amount_cents,row.os_settles_room,
          this.#historicalManifest.full_os_snapshot_hash,
          this.#historicalManifest.owner_decision_hash,this.#historicalManifest.sheet_snapshot_hash,
          row.sheet_row_snapshot_hash,row.sheet_order_source_version,
          row.money_aliases_hash,command.manifest_sha256,
          row.decision,requestKey,principal.subjectId]);
      // This disposition is deliberately absent from the Sheet money outbox.
      // The Sheet consumer does not support this non-cash source kind.
      const latest=await financeWatermark(client,propertyId);
      const changeSeq=latest+1;
      if (!Number.isSafeInteger(changeSeq)) throw Error('FINANCE_CHANGE_SEQ_OVERFLOW');
      await client.query(`INSERT INTO iron_gate.finance_change
        (property_id,change_seq,source_kind,source_id,source_version)
        VALUES ($1,$2,'legacy_settlement',$3,'1')`,[propertyId,changeSeq,id]);
      const response={receipt_status:'accepted',request_key:requestKey,
        disposition_id:id,booking_id:row.booking_id,decision:row.decision,
        booking_version:row.booking_version,booking_total_cents:row.booking_total_cents,
        sheet_order_source_version:row.sheet_order_source_version,
        cash_effect_cents:0,historical_cash_detail_missing:
          row.decision==='settled_before_cutover_cash_details_unknown',
        manifest_sha256:command.manifest_sha256,as_of_change_seq:changeSeq};
      const auditId=randomUUID();
      await client.query(`INSERT INTO iron_gate.audit_log
        (audit_id,property_id,audit_json) VALUES ($1,$2,$3::jsonb)`,
        [auditId,propertyId,JSON.stringify({auditId,propertyId,type:'finance.operation',
          action:'finance:import',operationKind:'historical_settlement',requestKey,
          requestHash,sourceInstanceId:principal.financeSourceInstanceId,
          actorRef:principal.subjectId,changeSeq,at:new Date().toISOString()})]);
      await client.query(`INSERT INTO iron_gate.finance_request_receipt
        (property_id,source_instance_id,request_key,request_hash,status,response_json)
        VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
        [propertyId,principal.financeSourceInstanceId,requestKey,requestHash,
          JSON.stringify(response)]);
      return response;
    });
  }
  async historicalSettlementReceipt(principal, propertyId, requestKey) {
    this.#authorize(principal,propertyId,'finance:import');
    if (principal.origin!=='finance' || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestKey))
      fail('SOURCE_FORBIDDEN',403);
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false,true);
      const rows=await client.query(`SELECT rr.response_json,d.id,d.booking_id,d.booking_version,
        d.booking_snapshot_hash,d.booking_total_cents,d.source_order_key,
        d.source_link_snapshot_hash,d.os_receipt_id,d.os_receipt_version,
        d.os_receipt_snapshot_hash,d.os_receipt_amount_cents,d.os_settles_room,
        d.full_os_snapshot_hash,d.owner_decision_hash,
        d.sheet_snapshot_hash,d.sheet_row_snapshot_hash,d.sheet_order_source_version,
        d.money_aliases_hash,
        d.manifest_sha256,d.decision,d.cash_effect_cents,c.change_seq
        FROM iron_gate.finance_request_receipt rr
        JOIN iron_gate.finance_legacy_settlement d ON d.property_id=rr.property_id
          AND d.source_instance_id=rr.source_instance_id AND d.request_key=rr.request_key
        JOIN iron_gate.finance_change c ON c.property_id=d.property_id
          AND c.source_kind='legacy_settlement' AND c.source_id=d.id::text
          AND c.source_version='1'
        WHERE rr.property_id=$1 AND rr.source_instance_id=$2 AND rr.request_key=$3`,
        [propertyId,principal.financeSourceInstanceId,requestKey]);
      if (rows.rows.length!==1) fail('REQUEST_NOT_FOUND',404);
      const {response_json,change_seq,...disposition}=rows.rows[0];
      if (Number(change_seq)!==response_json.as_of_change_seq ||
        response_json.disposition_id!==disposition.id ||
        response_json.booking_id!==disposition.booking_id ||
        response_json.decision!==disposition.decision ||
        response_json.booking_version!==Number(disposition.booking_version) ||
        response_json.booking_total_cents!==Number(disposition.booking_total_cents) ||
        response_json.sheet_order_source_version!==disposition.sheet_order_source_version ||
        response_json.manifest_sha256!==disposition.manifest_sha256 ||
        response_json.cash_effect_cents!==0 || Number(disposition.cash_effect_cents)!==0)
        fail('READBACK_MISMATCH',409);
      const manifest=this.#historicalManifest;
      const pinned=manifest?.rows.find(row=>row.booking_id===disposition.booking_id);
      if (!manifest || manifest.sha256!==disposition.manifest_sha256 || !pinned ||
        manifest.full_os_snapshot_hash!==disposition.full_os_snapshot_hash ||
        manifest.owner_decision_hash!==disposition.owner_decision_hash ||
        manifest.sheet_snapshot_hash!==disposition.sheet_snapshot_hash ||
        pinned.decision!==disposition.decision ||
        pinned.booking_version!==Number(disposition.booking_version) ||
        pinned.booking_total_cents!==Number(disposition.booking_total_cents) ||
        pinned.booking_snapshot_hash!==disposition.booking_snapshot_hash ||
        pinned.source_order_key!==disposition.source_order_key ||
        pinned.source_link_snapshot_hash!==disposition.source_link_snapshot_hash ||
        pinned.os_receipt_id!==disposition.os_receipt_id ||
        pinned.os_receipt_version!==disposition.os_receipt_version ||
        pinned.os_receipt_snapshot_hash!==disposition.os_receipt_snapshot_hash ||
        pinned.os_receipt_amount_cents!==Number(disposition.os_receipt_amount_cents) ||
        pinned.os_settles_room!==disposition.os_settles_room ||
        pinned.sheet_row_snapshot_hash!==disposition.sheet_row_snapshot_hash ||
        pinned.sheet_order_source_version!==disposition.sheet_order_source_version ||
        pinned.money_aliases_hash!==disposition.money_aliases_hash)
        fail('READBACK_MISMATCH',409);
      const overlap=await client.query(`SELECT 1 FROM iron_gate.finance_allocation
        WHERE property_id=$1 AND booking_id=$2 LIMIT 1`,
        [propertyId,disposition.booking_id]);
      const link=await client.query(`SELECT 1 FROM iron_gate.finance_source_link
        WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3
          AND booking_id=$4 AND verified_booking_version=$5
          AND source_snapshot_hash=$6`,
        [propertyId,principal.financeSourceInstanceId,disposition.source_order_key,
          disposition.booking_id,disposition.booking_version,
          disposition.source_link_snapshot_hash]);
      if (overlap.rows.length && disposition.decision===
          'settled_before_cutover_cash_details_unknown' || link.rows.length!==1)
        fail('READBACK_MISMATCH',409);
      return {...response_json,disposition,readback_verified:true};
    });
  }
  #sourceLinkInput(raw, requestKey) {
    const keys = new Set(['request_key','source_order_key','booking_id',
      'expected_booking_version','source_snapshot_hash','evidence_ref','review_confirmed',
      'preview_token','origin_request_hash']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !keys.has(key)) ||
      raw.request_key !== requestKey ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.source_order_key ?? '') ||
      !UUID.test(raw.booking_id ?? '') ||
      !Number.isSafeInteger(raw.expected_booking_version) ||
      raw.expected_booking_version < 1 ||
      !HEX.test(raw.source_snapshot_hash ?? '') ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.evidence_ref ?? '') ||
      raw.review_confirmed !== true ||
      raw.origin_request_hash != null && !HEX.test(raw.origin_request_hash)) fail('INVALID_INPUT');
    const { preview_token, ...checked } = raw;
    void preview_token;
    return checked;
  }
  async sourceLinkPreview(principal, propertyId, raw, requestKey) {
    this.#authorize(principal,propertyId,'finance:import');
    const checked = this.#sourceLinkInput(raw,requestKey);
    return this.#transaction(propertyId,false,async client => {
      const { state, source } = await this.#context(client,principal,propertyId,false,true);
      if (source.cutover_at) fail('SOURCE_FORBIDDEN',403);
      const bookings = this.#bookings(state,{booking_allocations:[{
        booking_id:checked.booking_id,
        expected_booking_version:checked.expected_booking_version }]});
      const existing = await client.query(`SELECT booking_id,verified_booking_version,
        source_snapshot_hash FROM iron_gate.finance_source_link
        WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3`,
        [propertyId,principal.financeSourceInstanceId,checked.source_order_key]);
      if (existing.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      return { source_order_key:checked.source_order_key,booking_id:checked.booking_id,
        booking_version:checked.expected_booking_version,
        preview_token:this.#token(principal,propertyId,checked,bookings) };
    });
  }
  async sourceLinkCommit(principal, propertyId, raw, requestKey) {
    const checked = this.#sourceLinkInput(raw,requestKey);
    return this.#operation(principal,propertyId,'finance:import',raw,requestKey,
      async (client,{state}) => {
        const bookings = this.#bookings(state,{booking_allocations:[{
          booking_id:checked.booking_id,
          expected_booking_version:checked.expected_booking_version }]});
        this.#verifyToken(raw.preview_token,principal,propertyId,checked,bookings);
        const existing = await client.query(`SELECT 1 FROM iron_gate.finance_source_link
          WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3`,
          [propertyId,principal.financeSourceInstanceId,checked.source_order_key]);
        if (existing.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        await client.query(`INSERT INTO iron_gate.finance_source_link
          (property_id,source_instance_id,source_order_key,booking_id,
           verified_booking_version,source_snapshot_hash,evidence_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [propertyId,principal.financeSourceInstanceId,checked.source_order_key,
            checked.booking_id,checked.expected_booking_version,
            checked.source_snapshot_hash,checked.evidence_ref]);
        return { receipt_status:'accepted',request_key:requestKey,
          source_order_key:checked.source_order_key,booking_id:checked.booking_id,
          booking_version:checked.expected_booking_version,cash_effect_cents:0 };
      },true);
  }
  #liveLinkInput(raw,requestKey) {
    const allowed = new Set(['request_key','source_order_key','booking_id',
      'expected_booking_version','review_confirmed','preview_token','origin_request_hash']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !allowed.has(key)) ||
      raw.request_key !== requestKey || !UUID.test(raw.booking_id ?? '') ||
      raw.source_order_key !== `${raw.booking_id}:v${raw.expected_booking_version}` ||
      !Number.isSafeInteger(raw.expected_booking_version) ||
      raw.expected_booking_version < 1 || raw.review_confirmed !== true ||
      raw.origin_request_hash != null && !HEX.test(raw.origin_request_hash))
      fail('INVALID_INPUT');
    const {preview_token,...checked}=raw;
    void preview_token;
    return checked;
  }
  #assertLiveLinkSource(principal,source) {
    const allowed = principal.origin === 'os' && source.source_system === 'os_manual' ||
      principal.origin === 'line' && source.source_system === 'line_finance';
    if (!allowed || !source.cutover_at || Date.parse(source.cutover_at) > Date.now())
      fail('SOURCE_FORBIDDEN',403);
  }
  async liveSourceLinkPreview(principal,propertyId,raw,requestKey) {
    this.#authorize(principal,propertyId,'finance:link');
    const checked=this.#liveLinkInput(raw,requestKey);
    return this.#transaction(propertyId,false,async client => {
      const {state,source}=await this.#context(client,principal,propertyId,false);
      this.#assertLiveLinkSource(principal,source);
      const bookings=this.#bookings(state,{booking_allocations:[{
        booking_id:checked.booking_id,
        expected_booking_version:checked.expected_booking_version}]});
      const existing=await client.query(`SELECT booking_id,verified_booking_version,
        source_snapshot_hash FROM iron_gate.finance_source_link
        WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3`,
        [propertyId,principal.financeSourceInstanceId,checked.source_order_key]);
      if(existing.rows.length && (existing.rows[0].booking_id!==checked.booking_id ||
        Number(existing.rows[0].verified_booking_version)!==checked.expected_booking_version ||
        existing.rows[0].source_snapshot_hash!==bookings[0].snapshotHash))
        fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      return {source_order_key:checked.source_order_key,
        booking_id:checked.booking_id,booking_version:checked.expected_booking_version,
        source_snapshot_hash:bookings[0].snapshotHash,
        preview_token:this.#token(principal,propertyId,checked,bookings)};
    });
  }
  async liveSourceLinkCommit(principal,propertyId,raw,requestKey) {
    const checked=this.#liveLinkInput(raw,requestKey);
    return this.#operation(principal,propertyId,'finance:link',raw,requestKey,
      async (client,{state,source}) => {
        this.#assertLiveLinkSource(principal,source);
        const bookings=this.#bookings(state,{booking_allocations:[{
          booking_id:checked.booking_id,
          expected_booking_version:checked.expected_booking_version}]});
        this.#verifyToken(raw.preview_token,principal,propertyId,checked,bookings);
        const existing=await client.query(`SELECT booking_id,verified_booking_version,
          source_snapshot_hash FROM iron_gate.finance_source_link
          WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3`,
          [propertyId,principal.financeSourceInstanceId,checked.source_order_key]);
        if(existing.rows.length){
          const prior=existing.rows[0];
          if(prior.booking_id!==checked.booking_id ||
            Number(prior.verified_booking_version)!==checked.expected_booking_version ||
            prior.source_snapshot_hash!==bookings[0].snapshotHash)
            fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        } else await client.query(`INSERT INTO iron_gate.finance_source_link
          (property_id,source_instance_id,source_order_key,booking_id,
           verified_booking_version,source_snapshot_hash,evidence_ref)
          VALUES ($1,$2,$3,$4,$5,$6,'iron_gate_exact_booking_uuid')`,
          [propertyId,principal.financeSourceInstanceId,checked.source_order_key,
            checked.booking_id,checked.expected_booking_version,bookings[0].snapshotHash]);
        return {receipt_status:'accepted',request_key:requestKey,
          source_order_key:checked.source_order_key,booking_id:checked.booking_id,
          booking_version:checked.expected_booking_version,
          source_snapshot_hash:bookings[0].snapshotHash,cash_effect_cents:0};
      });
  }
  async sourceLinks(principal,propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT source_instance_id,source_order_key,
        booking_id,verified_booking_version,source_snapshot_hash
        FROM iron_gate.finance_source_link WHERE property_id=$1
        ORDER BY source_instance_id,source_order_key LIMIT 10001`,[propertyId]);
      if(result.rows.length>10000)fail('LIMIT_REACHED',409);
      return {source_links:result.rows,
        as_of_change_seq:await financeWatermark(client,propertyId)};
    });
  }
  async importIssue(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','source_record_id','source_version',
      'reason_code','severity','canonical_document_id','origin_request_hash']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.source_record_id ?? '') ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.source_version ?? '') ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(raw.reason_code ?? '') ||
      !['blocking','classification_only'].includes(raw.severity) ||
      (raw.canonical_document_id != null && !UUID.test(raw.canonical_document_id)))
      fail('INVALID_INPUT');
    return this.#operation(principal,propertyId,'finance:import',raw,requestKey,
      async client => {
        if (raw.canonical_document_id) {
          const document = await client.query(`SELECT 1 FROM iron_gate.finance_document
            WHERE property_id=$1 AND id=$2`,[propertyId,raw.canonical_document_id]);
          if (!document.rows.length) fail('DOCUMENT_NOT_FOUND',404);
        }
        const id = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_import_issue
          (id,property_id,source_instance_id,source_record_id,source_version,
           canonical_document_id,reason_code,severity)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (property_id,source_instance_id,source_record_id,source_version,reason_code)
          DO NOTHING`,
          [id,propertyId,principal.financeSourceInstanceId,raw.source_record_id,
            raw.source_version,raw.canonical_document_id ?? null,
            raw.reason_code,raw.severity]);
        const result = await client.query(`SELECT id,status,severity,canonical_document_id
          FROM iron_gate.finance_import_issue
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3
            AND source_version=$4 AND reason_code=$5`,
          [propertyId,principal.financeSourceInstanceId,raw.source_record_id,
            raw.source_version,raw.reason_code]);
        if (result.rows[0].severity !== raw.severity ||
          result.rows[0].canonical_document_id !== (raw.canonical_document_id ?? null))
          fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        return { receipt_status:'accepted',request_key:requestKey,
          issue_id:result.rows[0].id,issue_status:result.rows[0].status,cash_effect_cents:0 };
      },true);
  }
  async importIssues(principal, propertyId, status = 'open') {
    this.#authorize(principal,propertyId,'finance:import');
    if (!['open','resolved','all'].includes(status)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false,true);
      const result = await client.query(`SELECT id,source_record_id,source_version,
        canonical_document_id,reason_code,severity,status,created_at,resolved_at,
        resolution_ref,resolved_by_ref FROM iron_gate.finance_import_issue
        WHERE property_id=$1 AND source_instance_id=$2
          AND ($3='all' OR status=$3)
        ORDER BY created_at,id LIMIT 1000`,
        [propertyId,principal.financeSourceInstanceId,status]);
      return { issues:result.rows,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async resolveImportIssue(principal, propertyId, issueId, raw, requestKey) {
    if (!UUID.test(issueId) || !raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !['request_key','resolution_ref',
        'origin_request_hash'].includes(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.resolution_ref ?? ''))
      fail('INVALID_INPUT');
    return this.#operation(principal,propertyId,'finance:import',raw,requestKey,
      async client => {
        const result = await client.query(`UPDATE iron_gate.finance_import_issue
          SET status='resolved',resolved_at=now(),resolution_ref=$1,resolved_by_ref=$2
          WHERE property_id=$3 AND source_instance_id=$4 AND id=$5 AND status='open'
          RETURNING id`,
          [raw.resolution_ref,principal.subjectId,propertyId,
            principal.financeSourceInstanceId,issueId]);
        if (!result.rows.length) fail('ISSUE_NOT_OPEN',409);
        return { receipt_status:'accepted',request_key:requestKey,
          issue_id:issueId,issue_status:'resolved',cash_effect_cents:0 };
      },true);
  }
  async #operation(principal, propertyId, action, raw, requestKey, fn, shadowImport = false) {
    this.#authorize(principal, propertyId, action);
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' ||
      raw.request_key !== requestKey || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestKey))
      fail('INVALID_INPUT');
    if (raw.origin_request_hash != null && !HEX.test(raw.origin_request_hash))
      fail('INVALID_INPUT');
    if (!shadowImport &&
      (raw.source_actor_ref != null || raw.source_recorded_at != null ||
        raw.origin_source_version != null))
      fail('INVALID_INPUT');
    const requestHash = hash(action === 'finance:link' ?
      Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'preview_token')) : raw);
    return this.#transaction(propertyId, true, async client => {
      const context = await this.#context(client, principal, propertyId, true, shadowImport);
      const previous = await client.query(`SELECT request_hash,response_json
        FROM iron_gate.finance_request_receipt WHERE property_id=$1 AND source_instance_id=$2
          AND request_key=$3`, [propertyId,principal.financeSourceInstanceId,requestKey]);
      if (previous.rows.length) {
        if (previous.rows[0].request_hash !== requestHash) fail('REQUEST_KEY_REUSED',409);
        return previous.rows[0].response_json;
      }
      const operationResult = await fn(client,context);
      const [changeKind, changeSourceId, changeVersion] = operationChange(
        raw,operationResult,requestKey,principal.financeSourceInstanceId);
      const changeSeq = await appendFinanceChange(client,propertyId,
        changeKind,changeSourceId,changeVersion);
      const response = { ...operationResult, as_of_change_seq:changeSeq,
        ...(raw.origin_request_hash ? { origin_request_hash:raw.origin_request_hash } : {}) };
      const operationKind = action === 'finance:plan' ?
        raw.cadence ? raw.status === 'ended' ? 'recurring_stopped' : 'recurring_created' :
          raw.platform ? 'payout_rule_updated' :
            raw.last_digits ? 'payment_account_created' : 'category_created' :
        action === 'finance:link' ? 'source_link_verified' :
          action === 'finance:status' ? 'calendar_payment_confirmed' :
          action === 'finance:evidence' ? 'evidence_recorded' :
            action === 'finance:settlement' ? 'settlement_recorded' :
              action === 'finance:import' ? 'historical_imported' : 'legacy_unknown';
      const auditId = randomUUID();
      await client.query(`INSERT INTO iron_gate.audit_log
        (audit_id,property_id,audit_json) VALUES ($1,$2,$3::jsonb)`,
        [auditId,propertyId,JSON.stringify({ auditId, propertyId,
          type:'finance.operation',action,operationKind,requestKey,requestHash,
          sourceInstanceId:principal.financeSourceInstanceId,
          actorRef:principal.subjectId,changeSeq,at:new Date().toISOString() })]);
      await client.query(`INSERT INTO iron_gate.finance_request_receipt
        (property_id,source_instance_id,request_key,request_hash,status,response_json)
        VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
        [propertyId,principal.financeSourceInstanceId,requestKey,requestHash,JSON.stringify(response)]);
      return response;
    });
  }
  async #recordImportCatalog(client,principal,propertyId,recordKind,
    sourceRecordId,targetVersion,targetRef,raw) {
    assertImportCatalogProvenance(raw);
    const {request_key,origin_request_hash,origin_source_version,
      source_actor_ref,source_recorded_at,...payload}=raw;
    void request_key;
    await client.query(`INSERT INTO iron_gate.finance_import_catalog
      (id,property_id,source_instance_id,record_kind,source_record_id,
       source_version,target_version,target_ref,source_snapshot_hash,
       source_actor_ref,source_recorded_at,imported_payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [randomUUID(),propertyId,principal.financeSourceInstanceId,recordKind,
        sourceRecordId,origin_source_version,targetVersion,targetRef,origin_request_hash,
        source_actor_ref,source_recorded_at,JSON.stringify(payload)]);
  }
  async importCatalog(principal,propertyId,{limit=50,cursor=null,
    as_of_change_seq=null}={}) {
    this.#authorize(principal,propertyId,'finance:import');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      cursor != null && !UUID.test(cursor) ||
      as_of_change_seq != null && (!Number.isSafeInteger(as_of_change_seq) ||
        as_of_change_seq < 0)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false,true);
      const watermark=await financeWatermark(client,propertyId);
      if (as_of_change_seq != null && watermark !== as_of_change_seq)
        fail('VERSION_CONFLICT',409);
      const result=await client.query(`SELECT id,source_instance_id,record_kind,
        source_record_id,source_version,target_version,target_ref,source_snapshot_hash,
        source_actor_ref,source_recorded_at,imported_payload,imported_at
        FROM iron_gate.finance_import_catalog
        WHERE property_id=$1 AND source_instance_id=$2
          AND ($3::uuid IS NULL OR id>$3::uuid)
        ORDER BY id LIMIT $4`,[propertyId,principal.financeSourceInstanceId,cursor,limit+1]);
      const entries=[];
      for (const row of result.rows.slice(0,limit)) {
        let current;
        if (row.record_kind==='operational_status') {
          current=await client.query(`SELECT id,source_instance_id,source_record_id,
            version,booking_id,status_code,settles_room,recorded_at,
            source_recorded_at
            FROM iron_gate.finance_operational_status
            WHERE property_id=$1 AND source_instance_id=$2 AND id=$3::uuid`,
            [propertyId,principal.financeSourceInstanceId,row.target_ref]);
        } else if (row.record_kind==='recurring_rule') {
          current=await client.query(`SELECT id,source_instance_id,source_record_id,
            version,cadence,start_on,end_on,next_due_on,status,category_code,
            amount_cents,safe_description,payment_method_code,due_day
            FROM iron_gate.finance_recurring_rule
            WHERE property_id=$1 AND source_instance_id=$2 AND id=$3::uuid`,
            [propertyId,principal.financeSourceInstanceId,row.target_ref]);
        } else if (row.record_kind==='payout_rule') {
          current=await client.query(`SELECT platform,version,mode,day,offset_days,
            offset_months,status FROM iron_gate.finance_payout_rule
            WHERE property_id=$1 AND platform=$2`,[propertyId,row.target_ref]);
        } else if (row.record_kind==='account') {
          current=await client.query(`SELECT code,display_name,kind,last_digits,
            status,version FROM iron_gate.finance_account
            WHERE property_id=$1 AND code=$2`,[propertyId,row.target_ref]);
        } else if (row.record_kind==='category') {
          const [kind,code]=row.target_ref.split(':');
          current=await client.query(`SELECT kind,code,label,status,version
            FROM iron_gate.finance_category
            WHERE property_id=$1 AND kind=$2 AND code=$3`,[propertyId,kind,code]);
        }
        const value=current?.rows[0] ?? null;
        entries.push({...row,target_current:value && {
          ...value,...Object.fromEntries(['start_on','end_on','next_due_on']
            .filter(key => key in value).map(key => [key,pgDay(value[key])])) }});
      }
      return {entries,next_cursor:result.rows.length>limit?entries.at(-1)?.id:null,
        as_of_change_seq:watermark};
    });
  }
  async statusCommand(principal, propertyId, raw, requestKey, shadowImport = false) {
    const keys = new Set(['request_key','source_record_id','version','status_code',
      'settles_room','booking_id','expected_booking_version','origin_request_hash',
      'source_actor_ref','source_recorded_at','source_order_key',
      'source_snapshot_hash','origin_source_version']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.source_record_id ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.status_code ?? '') ||
      typeof raw.settles_room !== 'boolean' ||
      (raw.settles_room && !UUID.test(raw.booking_id ?? '')) ||
      (raw.booking_id != null && !UUID.test(raw.booking_id))) fail('INVALID_INPUT');
    if (!shadowImport &&
      (raw.source_order_key != null || raw.source_snapshot_hash != null))
      fail('INVALID_INPUT');
    if (shadowImport && raw.booking_id &&
      (!/^[A-Za-z0-9._:-]{1,256}$/.test(raw.source_order_key ?? '') ||
        !HEX.test(raw.source_snapshot_hash ?? '')) ||
      shadowImport && !raw.booking_id &&
        (raw.source_order_key != null || raw.source_snapshot_hash != null))
      fail('INVALID_INPUT');
    if (shadowImport) assertImportCatalogProvenance(raw);
    return this.#operation(principal,propertyId,
      shadowImport ? 'finance:import' : 'finance:status',raw,requestKey,
      async (client,{state,source}) => {
        if (shadowImport && source.source_system !== 'os_legacy_payment')
          fail('SOURCE_FORBIDDEN',403);
        if (raw.booking_id) {
          const booking = state.bookings.find(b => b.id === raw.booking_id);
          if (!booking) fail('UNKNOWN_BOOKING',422);
          if (booking.version !== raw.expected_booking_version) fail('VERSION_CONFLICT',409);
          if (raw.settles_room) {
            // An owner-reviewed unpaid historical receipt cannot later be
            // imported or confirmed as settling the room without resolution.
            const unpaid=await client.query(`SELECT 1
              FROM iron_gate.finance_legacy_settlement
              WHERE property_id=$1 AND booking_id=$2
                AND decision='unpaid_at_cutover' LIMIT 1`,
              [propertyId,raw.booking_id]);
            if (unpaid.rows.length) fail('HISTORICAL_SETTLEMENT_REVIEW_REQUIRED',409);
          }
          if (shadowImport) {
            const linked=await client.query(`SELECT 1 FROM iron_gate.finance_source_link
              WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3
                AND booking_id=$4 AND source_snapshot_hash=$5
                AND verified_booking_version=$6`,
              [propertyId,principal.financeSourceInstanceId,raw.source_order_key,
                raw.booking_id,raw.source_snapshot_hash,raw.expected_booking_version]);
            if (linked.rows.length !== 1) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
          }
        }
        const prior = await client.query(`SELECT max(version)::int AS version
          FROM iron_gate.finance_operational_status
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
          [propertyId,principal.financeSourceInstanceId,raw.source_record_id]);
        if (raw.version !== (prior.rows[0].version ?? 0)+1) fail('VERSION_CONFLICT',409);
        const statusId = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_operational_status
          (id,property_id,booking_id,source_instance_id,source_record_id,
           version,status_code,settles_room,source_recorded_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [statusId,propertyId,raw.booking_id ?? null,principal.financeSourceInstanceId,
            raw.source_record_id,raw.version,raw.status_code,raw.settles_room,
            shadowImport ? raw.source_recorded_at : null]);
        if (shadowImport) await this.#recordImportCatalog(client,principal,propertyId,
          'operational_status',raw.source_record_id,raw.version,statusId,raw);
        return { receipt_status:'accepted',request_key:requestKey,status_id:statusId,
          version:raw.version,cash_effect_cents:0 };
      },shadowImport);
  }
  async statuses(principal, propertyId, bookingId = null) {
    this.#authorize(principal,propertyId,'finance:read');
    if (bookingId != null && !UUID.test(bookingId)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT id,booking_id,source_record_id,version,
        status_code,settles_room,recorded_at,
        to_char(source_recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_recorded_at
        FROM iron_gate.finance_operational_status
        WHERE property_id=$1 AND ($2::uuid IS NULL OR booking_id=$2::uuid)
        ORDER BY COALESCE(source_recorded_at,recorded_at) DESC,id DESC LIMIT 100`,
        [propertyId,bookingId]);
      return { statuses:result.rows, cash_effect_cents:0,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async recurringRule(principal, propertyId, raw, requestKey, shadowImport = false) {
    if (!shadowImport && principal.financeGeneralEntriesOnly === true)
      fail('SOURCE_FORBIDDEN',403);
    const keys = new Set(['request_key','source_record_id','version','cadence','start_on',
      'end_on','next_due_on','status','category_code','amount_cents',
      'safe_description','payment_method_code','due_day','origin_request_hash',
      'source_actor_ref','source_recorded_at','origin_source_version']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.source_record_id ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !['weekly','monthly','yearly'].includes(raw.cadence) ||
      !['active','paused','ended'].includes(raw.status) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.category_code ?? '') ||
      !Number.isSafeInteger(raw.amount_cents) || raw.amount_cents <= 0 ||
      raw.amount_cents > MAX_AMOUNT ||
      typeof raw.safe_description !== 'string' || raw.safe_description.length > 500 ||
      /[\u0000-\u001f\u007f]/.test(raw.safe_description) ||
      !METHODS.has(raw.payment_method_code) ||
      !Number.isSafeInteger(raw.due_day) || raw.due_day < 1 || raw.due_day > 31)
      fail('INVALID_INPUT');
    const start = day(raw.start_on,true), end = day(raw.end_on), next = day(raw.next_due_on);
    if (end && end < start || next && (next < start || end && next > end)) fail('INVALID_DATE');
    if (shadowImport) assertImportCatalogProvenance(raw);
    return this.#operation(principal,propertyId,
      shadowImport ? 'finance:import' : 'finance:plan',raw,requestKey,
      async (client,{source}) => {
        if (shadowImport && source.source_system !== 'os_manual')
          fail('SOURCE_FORBIDDEN',403);
        const category = await client.query(`SELECT 1 FROM iron_gate.finance_category
          WHERE property_id=$1 AND kind='expense' AND code=$2 AND status='active'`,
          [propertyId,raw.category_code]);
        if (!category.rows.length) fail('INVALID_CATEGORY',422);
        const prior = await client.query(`SELECT id,version FROM iron_gate.finance_recurring_rule
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
          [propertyId,principal.financeSourceInstanceId,raw.source_record_id]);
        if (raw.version !== (prior.rows[0]?.version ?? 0)+1) fail('VERSION_CONFLICT',409);
        const id = prior.rows[0]?.id ?? randomUUID();
        if (prior.rows.length) await client.query(`UPDATE iron_gate.finance_recurring_rule
          SET version=$1,cadence=$2,start_on=$3,end_on=$4,next_due_on=$5,
            status=$6,category_code=$7,amount_cents=$8,safe_description=$9,
            payment_method_code=$10,due_day=$11 WHERE property_id=$12 AND id=$13`,
          [raw.version,raw.cadence,start,end,next,raw.status,raw.category_code,
            raw.amount_cents,raw.safe_description,raw.payment_method_code,raw.due_day,
            propertyId,id]);
        else await client.query(`INSERT INTO iron_gate.finance_recurring_rule
          (id,property_id,source_instance_id,source_record_id,version,cadence,
           start_on,end_on,next_due_on,status,category_code,amount_cents,
           safe_description,payment_method_code,due_day)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [id,propertyId,principal.financeSourceInstanceId,raw.source_record_id,
            raw.version,raw.cadence,start,end,next,raw.status,raw.category_code,
            raw.amount_cents,raw.safe_description,raw.payment_method_code,raw.due_day]);
        if (shadowImport) await this.#recordImportCatalog(client,principal,propertyId,
          'recurring_rule',raw.source_record_id,raw.version,id,raw);
        return { receipt_status:'accepted',request_key:requestKey,rule_id:id,
          version:raw.version,cash_effect_cents:0 };
      },shadowImport);
  }
  async recurringRules(principal, propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT id,source_record_id,version,cadence,
        start_on,end_on,next_due_on,status,category_code,amount_cents,
        safe_description,payment_method_code,due_day FROM iron_gate.finance_recurring_rule
        WHERE property_id=$1 ORDER BY id LIMIT 1001`, [propertyId]);
      if(result.rows.length>1000)fail('LIMIT_REACHED',409);
      return { recurring_rules:result.rows.map(row => ({...row,
        start_on:pgDay(row.start_on),end_on:pgDay(row.end_on),
        next_due_on:pgDay(row.next_due_on)})), cash_effect_cents:0,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async payoutRule(principal, propertyId, raw, requestKey, shadowImport = false) {
    if (!shadowImport && principal.financeGeneralEntriesOnly === true)
      fail('SOURCE_FORBIDDEN',403);
    const keys = new Set(['request_key','platform','version','mode','day','offset_days',
      'offset_months','status','origin_request_hash',
      'source_actor_ref','source_recorded_at','origin_source_version']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw?.platform ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !['fixed_day','offset_days','manual'].includes(raw.mode) ||
      !['active','disabled'].includes(raw.status) ||
      (raw.mode === 'fixed_day' ? !Number.isSafeInteger(raw.day) || raw.day < 1 ||
        raw.day > 31 || raw.offset_days != null ||
        (raw.offset_months != null && (!Number.isSafeInteger(raw.offset_months) ||
          raw.offset_months < 1 || raw.offset_months > 3)) : raw.mode === 'offset_days' ?
        !Number.isSafeInteger(raw.offset_days) || raw.offset_days < 0 ||
        raw.offset_days > 90 || raw.day != null || raw.offset_months != null :
        raw.day != null || raw.offset_days != null || raw.offset_months != null))
      fail('INVALID_INPUT');
    if (shadowImport) assertImportCatalogProvenance(raw);
    return this.#operation(principal,propertyId,
      shadowImport ? 'finance:import' : 'finance:plan',raw,requestKey,
      async (client,{source}) => {
        if (shadowImport && source.source_system !== 'os_manual')
          fail('SOURCE_FORBIDDEN',403);
        const prior = await client.query(`SELECT version FROM iron_gate.finance_payout_rule
          WHERE property_id=$1 AND platform=$2`, [propertyId,raw.platform]);
        if (shadowImport && prior.rows.length) {
          const owner=await client.query(`SELECT source_instance_id,source_record_id,
            target_version FROM iron_gate.finance_import_catalog
            WHERE property_id=$1 AND record_kind='payout_rule' AND target_ref=$2
            ORDER BY target_version DESC LIMIT 1`,[propertyId,raw.platform]);
          if (!owner.rows.length ||
            owner.rows[0].source_instance_id!==principal.financeSourceInstanceId ||
            owner.rows[0].source_record_id!==raw.platform ||
            owner.rows[0].target_version!==prior.rows[0].version)
            fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        }
        if (raw.version !== (prior.rows[0]?.version ?? 0)+1) fail('VERSION_CONFLICT',409);
        if (prior.rows.length) await client.query(`UPDATE iron_gate.finance_payout_rule
          SET version=$1,mode=$2,day=$3,offset_days=$4,offset_months=$5,status=$6
          WHERE property_id=$7 AND platform=$8`,
          [raw.version,raw.mode,raw.day ?? null,raw.offset_days ?? null,
            raw.offset_months ?? null,raw.status,propertyId,raw.platform]);
        else await client.query(`INSERT INTO iron_gate.finance_payout_rule
          (property_id,platform,mode,day,offset_days,offset_months,version,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [propertyId,raw.platform,raw.mode,raw.day ?? null,
            raw.offset_days ?? null,raw.offset_months ?? null,raw.version,raw.status]);
        if (shadowImport) await this.#recordImportCatalog(client,principal,propertyId,
          'payout_rule',raw.platform,raw.version,raw.platform,raw);
        return { receipt_status:'accepted',request_key:requestKey,
          platform:raw.platform,version:raw.version,cash_effect_cents:0 };
      },shadowImport);
  }
  async payoutRules(principal, propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT platform,mode,day,offset_days,offset_months,version,status
        FROM iron_gate.finance_payout_rule WHERE property_id=$1 ORDER BY platform`,[propertyId]);
      return { payout_rules:result.rows,cash_effect_cents:0,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async evidenceAssertion(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','event_id','evidence_level','evidence_ref',
      'processor_transaction_ref','settlement_batch_ref','bank_on','origin_request_hash']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) || !UUID.test(raw?.event_id ?? '') ||
      !['provider_notice','processor_confirmed','bank_reconciled'].includes(raw.evidence_level) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.evidence_ref ?? '') ||
      [raw.processor_transaction_ref,raw.settlement_batch_ref].some(value =>
        value != null && !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) ||
      (raw.evidence_level === 'bank_reconciled' && !raw.bank_on) ||
      (raw.evidence_level === 'processor_confirmed' &&
        !raw.processor_transaction_ref && !raw.settlement_batch_ref)) fail('INVALID_INPUT');
    if (day(raw.bank_on) && raw.bank_on > todayTaipei()) fail('FUTURE_RECEIPT',422);
    return this.#operation(principal,propertyId,'finance:evidence',raw,requestKey,
      async client => {
        const target = await client.query(`SELECT e.evidence_level,e.event_kind,e.cash_effect_cents,d.status,
          d.current_version,e.revision_version FROM iron_gate.finance_event e
          JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
          WHERE e.property_id=$1 AND e.id=$2`, [propertyId,raw.event_id]);
        if (!target.rows.length) fail('EVENT_NOT_FOUND',404);
        if (target.rows[0].event_kind==='reversal' || target.rows[0].status!=='active' ||
          target.rows[0].revision_version!==target.rows[0].current_version)
          fail('EVIDENCE_LEVEL_CONFLICT',409);
        if (raw.evidence_level==='bank_reconciled' &&
          Number(target.rows[0].cash_effect_cents)===0) fail('EVIDENCE_LEVEL_CONFLICT',409);
        const levels = ['operator_attested','provider_notice','processor_confirmed','bank_reconciled'];
        const previous = await client.query(`SELECT evidence_level FROM iron_gate.finance_evidence_assertion
          WHERE property_id=$1 AND event_id=$2`,[propertyId,raw.event_id]);
        const highest = Math.max(levels.indexOf(target.rows[0].evidence_level),
          ...previous.rows.map(row => levels.indexOf(row.evidence_level)));
        if (levels.indexOf(raw.evidence_level) <= highest)
          fail('EVIDENCE_LEVEL_CONFLICT',409);
        const existing = await client.query(`SELECT 1 FROM iron_gate.finance_evidence_assertion
          WHERE property_id=$1 AND event_id=$2 AND evidence_level=$3 AND evidence_ref=$4`,
          [propertyId,raw.event_id,raw.evidence_level,raw.evidence_ref]);
        if (existing.rows.length) fail('EVIDENCE_LEVEL_CONFLICT',409);
        const id = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_evidence_assertion
          (id,property_id,event_id,evidence_level,evidence_ref,
           processor_transaction_ref,settlement_batch_ref,bank_on,actor_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id,propertyId,raw.event_id,raw.evidence_level,raw.evidence_ref,
            raw.processor_transaction_ref ?? null,raw.settlement_batch_ref ?? null,
            day(raw.bank_on),principal.subjectId]);
        return { receipt_status:'accepted',request_key:requestKey,assertion_id:id,
          event_id:raw.event_id,cash_effect_cents:0 };
      });
  }
  async settlement(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','settlement_batch_ref','processor_transaction_ref',
      'gross_cents','refund_cents','fee_cents','net_cents','bank_on','evidence_ref',
      'links','origin_request_hash']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.settlement_batch_ref ?? '') ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.evidence_ref ?? '') ||
      (raw.processor_transaction_ref != null &&
        !/^[A-Za-z0-9._:-]{1,256}$/.test(raw.processor_transaction_ref)) ||
      !Array.isArray(raw.links) || raw.links.length > 100 ||
      raw.links.some(link => !link || Object.keys(link).some(key =>
        !['event_id','role','amount_cents'].includes(key)) ||
        !UUID.test(link.event_id) || !['gross','refund','fee'].includes(link.role) ||
        !Number.isSafeInteger(link.amount_cents) || link.amount_cents <= 0 ||
        link.amount_cents > MAX_AMOUNT) ||
      new Set(raw.links.map(link => `${link.event_id}:${link.role}`)).size !== raw.links.length ||
      ['gross_cents','refund_cents','fee_cents','net_cents'].some(key =>
        !Number.isSafeInteger(raw[key]) || raw[key] < 0 || raw[key] > MAX_AMOUNT) ||
      raw.gross_cents-raw.refund_cents-raw.fee_cents !== raw.net_cents ||
      raw.links.length===0 ||
      ['gross','refund','fee'].some((role,index) => raw.links.filter(link => link.role===role)
        .reduce((n,link) => n+link.amount_cents,0) !==
        raw[['gross_cents','refund_cents','fee_cents'][index]])) fail('ALLOCATION_MISMATCH',422);
    day(raw.bank_on);
    return this.#operation(principal,propertyId,'finance:settlement',raw,requestKey,
      async client => {
        const existing = await client.query(`SELECT 1 FROM iron_gate.finance_settlement
          WHERE property_id=$1 AND source_instance_id=$2 AND settlement_batch_ref=$3`,
          [propertyId,principal.financeSourceInstanceId,raw.settlement_batch_ref]);
        if (existing.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        for (const link of raw.links) {
          const event = await client.query(`SELECT e.event_kind,e.amount_cents,
            e.revision_version,d.current_version,d.status FROM iron_gate.finance_event e
            JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
            WHERE e.property_id=$1 AND e.id=$2`, [propertyId,link.event_id]);
          if (!event.rows.length || link.amount_cents > Number(event.rows[0].amount_cents) ||
            event.rows[0].status!=='active' ||
            event.rows[0].revision_version!==event.rows[0].current_version ||
            (link.role==='gross' && !['property_receipt','ota_payout'].includes(event.rows[0].event_kind)) ||
            (link.role==='refund' && event.rows[0].event_kind!=='property_refund') ||
            (link.role==='fee' && event.rows[0].event_kind!=='processor_fee_paid'))
            fail('ALLOCATION_MISMATCH',422);
          const settled = await client.query(`SELECT COALESCE(sum(amount_cents),0)::bigint AS total
            FROM iron_gate.finance_settlement_link WHERE property_id=$1 AND event_id=$2 AND role=$3`,
            [propertyId,link.event_id,link.role]);
          if (Number(settled.rows[0].total)+link.amount_cents > Number(event.rows[0].amount_cents))
            fail('ALLOCATION_MISMATCH',422);
        }
        const id = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_settlement
          (id,property_id,source_instance_id,settlement_batch_ref,processor_transaction_ref,
           gross_cents,refund_cents,fee_cents,net_cents,bank_on,evidence_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id,propertyId,principal.financeSourceInstanceId,raw.settlement_batch_ref,
            raw.processor_transaction_ref ?? null,raw.gross_cents,raw.refund_cents,
            raw.fee_cents,raw.net_cents,day(raw.bank_on),raw.evidence_ref]);
        for (const link of raw.links) await client.query(`INSERT INTO iron_gate.finance_settlement_link
          (settlement_id,property_id,event_id,role,amount_cents)
          VALUES ($1,$2,$3,$4,$5)`,
          [id,propertyId,link.event_id,link.role,link.amount_cents]);
        return { receipt_status:'accepted',request_key:requestKey,settlement_id:id,
          gross_cents:raw.gross_cents,refund_cents:raw.refund_cents,
          fee_cents:raw.fee_cents,net_cents:raw.net_cents,
          cash_effect_cents:0 };
      });
  }
  async settlements(principal, propertyId, limit = 50, cursor = null) {
    this.#authorize(principal,propertyId,'finance:read');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      cursor != null && !UUID.test(cursor)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT id,settlement_batch_ref,gross_cents,
        refund_cents,fee_cents,net_cents,bank_on,evidence_ref,created_at
        FROM iron_gate.finance_settlement WHERE property_id=$1 AND
          ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
          [propertyId,cursor,limit+1]);
      const page = result.rows.slice(0,limit).map(row => ({...row,bank_on:pgDay(row.bank_on)}));
      return { settlements:page,next_cursor:result.rows.length>limit?page.at(-1)?.id:null,
        cash_effect_cents:0,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async ledger(principal, propertyId, query = {}, shadowImport = false) {
    this.#authorize(principal, propertyId, shadowImport ? 'finance:import' : 'finance:read');
    const limit = Number(query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    const from = day(query.from), to = day(query.to);
    if (from && to && to < from) fail('INVALID_DATE');
    const requestedSeq = query.as_of_change_seq == null ? null :
      Number(query.as_of_change_seq);
    if (requestedSeq !== null && (!Number.isSafeInteger(requestedSeq) || requestedSeq < 0))
      fail('INVALID_INPUT');
    let cursorDay = null, cursorId = null;
    if (query.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
        cursorDay = day(decoded[0], true);
        cursorId = decoded[1];
        if (!UUID.test(cursorId)) fail('INVALID_CURSOR');
      } catch { fail('INVALID_CURSOR'); }
    }
    return this.#transaction(propertyId, false, async client => {
      const {source} = await this.#context(client, principal, propertyId, false, shadowImport);
      const currentSeq = await financeWatermark(client,propertyId);
      if (requestedSeq !== null && requestedSeq > currentSeq) fail('INVALID_CURSOR');
      const snapshotSeq = requestedSeq ?? currentSeq;
      const unsequenced = await client.query(`SELECT count(*)::bigint AS total
        FROM iron_gate.finance_event e LEFT JOIN iron_gate.finance_change_event ce
          ON ce.property_id=e.property_id AND ce.event_id=e.id
        WHERE e.property_id=$1 AND ce.event_id IS NULL`,[propertyId]);
      const rows = await client.query(`SELECT e.id,e.document_id,e.revision_version,
        e.event_kind,e.amount_cents,e.cash_effect_cents,e.effective_on,e.cash_on,
        e.service_on,e.category_code,e.receipt_purpose,
        e.payment_method_code,e.payment_account_ref,e.advanced_by_ref,
        e.advanced_by_kind,e.advanced_by_label,
        e.safe_description,e.actor_ref,r.source_actor_ref,
        to_char(e.source_recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_recorded_at,
        to_char(r.source_recorded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS revision_source_recorded_at,
        e.evidence_ref,e.created_at,
        first_event.actor_ref AS origin_actor_ref,
        first_event.created_at AS origin_recorded_at,
        COALESCE(snapshot_r.actor_ref,current_r.actor_ref) AS current_actor_ref,
        COALESCE(snapshot_r.created_at,current_r.created_at) AS current_recorded_at,
        reversed.event_kind AS reversed_kind,
        reversed.receipt_purpose AS reversed_receipt_purpose,
        receipt_origin.receipt_purpose AS related_receipt_purpose,
        receipt_origin.service_on AS related_receipt_service_on,
        CASE WHEN snapshot_r.version IS NULL THEN d.status
          WHEN snapshot_r.action='void' THEN 'void' ELSE 'active' END AS document_status,
        COALESCE(snapshot_r.version,d.current_version) AS current_version,
        d.source_instance_id,
        r.action AS revision_action,r.source_version,
        CASE WHEN snapshot_r.version IS NULL THEN current_r.reason_note
          ELSE snapshot_r.reason_note END AS current_reason_note,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'booking_id',a.booking_id,'amount_cents',a.amount_cents,
          'allocation_kind',a.allocation_kind) ORDER BY a.booking_id,a.allocation_kind),'[]'::jsonb)
          FROM iron_gate.finance_allocation a WHERE a.property_id=e.property_id
            AND a.event_id=e.id) AS booking_allocations,
        (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'month',x.month,'amount_cents',x.amount_cents,
          'allocation_policy',x.allocation_policy) ORDER BY x.month),'[]'::jsonb)
          FROM iron_gate.finance_expense_attribution x WHERE x.property_id=e.property_id
            AND x.event_id=e.id) AS expense_attributions,
        COALESCE((SELECT a.evidence_level FROM iron_gate.finance_evidence_assertion a
          LEFT JOIN iron_gate.finance_change assertion_change
            ON assertion_change.property_id=a.property_id
            AND assertion_change.source_kind='evidence_assertion'
            AND assertion_change.source_id=a.id::text
          WHERE a.property_id=e.property_id AND a.event_id=e.id
            AND (assertion_change.change_seq <= $7::bigint OR assertion_change.change_seq IS NULL)
          ORDER BY CASE a.evidence_level WHEN 'bank_reconciled' THEN 3
            WHEN 'processor_confirmed' THEN 2 ELSE 1 END DESC LIMIT 1),
          e.evidence_level) AS evidence_level,e.reverses_event_id,
        e.related_receipt_event_id,d.source_system,d.source_record_id,
        ce.change_seq
        FROM iron_gate.finance_event e JOIN iron_gate.finance_document d
          ON d.property_id=e.property_id AND d.id=e.document_id
        LEFT JOIN iron_gate.finance_change_event ce ON ce.property_id=e.property_id
          AND ce.event_id=e.id
        JOIN iron_gate.finance_revision r ON r.property_id=e.property_id
          AND r.document_id=e.document_id AND r.version=e.revision_version
        JOIN iron_gate.finance_revision current_r ON current_r.property_id=d.property_id
          AND current_r.document_id=d.id AND current_r.version=d.current_version
        LEFT JOIN LATERAL (
          SELECT previous.version,previous.action,previous.actor_ref,
            previous.created_at,previous.reason_note
          FROM iron_gate.finance_revision previous
          JOIN iron_gate.finance_change revision_change
            ON revision_change.property_id=previous.property_id
            AND revision_change.source_kind='document_revision'
            AND revision_change.source_id=previous.document_id::text
            AND revision_change.source_version=previous.version::text
          WHERE previous.property_id=d.property_id
            AND previous.document_id=d.id
            AND revision_change.change_seq <= $7::bigint
          ORDER BY previous.version DESC LIMIT 1
        ) snapshot_r ON true
        LEFT JOIN LATERAL (SELECT actor_ref,created_at FROM iron_gate.finance_event first
          WHERE first.property_id=d.property_id AND first.document_id=d.id
            AND first.event_kind<>'reversal'
          ORDER BY first.revision_version,first.created_at,first.id LIMIT 1) first_event ON true
        LEFT JOIN iron_gate.finance_event reversed ON reversed.property_id=e.property_id
          AND reversed.id=e.reverses_event_id
        LEFT JOIN iron_gate.finance_event receipt_origin ON receipt_origin.property_id=e.property_id
          AND receipt_origin.id=COALESCE(e.related_receipt_event_id,reversed.related_receipt_event_id)
        WHERE e.property_id=$1 AND ($2::date IS NULL OR e.effective_on >= $2::date)
          AND ($3::date IS NULL OR e.effective_on <= $3::date)
          AND ($4::date IS NULL OR (e.effective_on,e.id) > ($4::date,$5::uuid))
          AND (ce.change_seq <= $7::bigint OR ce.change_seq IS NULL)
        ORDER BY e.effective_on,e.id LIMIT $6`,
        [propertyId,from,to,cursorDay,cursorId,limit+1,snapshotSeq]);
      const page = rows.rows.slice(0,limit).map(row => ({ ...row,
        change_seq:row.change_seq == null ? null : Number(row.change_seq),
        effective_on: pgDay(row.effective_on), cash_on: pgDay(row.cash_on),
        service_on: pgDay(row.service_on),
        related_receipt_service_on: pgDay(row.related_receipt_service_on) }));
      const last = page.at(-1);
      return { events: page, next_cursor: rows.rows.length > limit && last ?
        base64(JSON.stringify([last.effective_on,last.id])) : null,
        as_of_event_id: last?.id ?? null,
        property_id:propertyId,
        source_instance_id:principal.financeSourceInstanceId,
        source_system:source.source_system,
        source_sheet_ref:source.source_sheet_ref ?? null,
        as_of_change_seq:snapshotSeq,current_change_seq:currentSeq,
        unsequenced_event_count:Number(unsequenced.rows[0].total) };
    });
  }
  async importLedger(principal, propertyId, query = {}) {
    return this.ledger(principal,propertyId,query,true);
  }
  async activity(principal,propertyId,page=1,action='',query='') {
    this.#authorize(principal,propertyId,'finance:read');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000 ||
      typeof action !== 'string' || action.length > 64 ||
      typeof query !== 'string' || query.length > 200) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const rows = await client.query(`WITH activity AS (
        SELECT r.created_at AS at, r.document_id::text || ':' || r.version::text AS id,
          'money'::text AS source, r.action, r.actor_ref,r.source_actor_ref,
          to_char(r.source_recorded_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_recorded_at,
          r.document_id::text AS target_id, r.version AS version,
          d.source_system, e.event_kind, e.amount_cents,
          e.safe_description, r.reason_note,
          previous.amount_cents AS before_amount_cents,
          previous.safe_description AS before_safe_description,
          NULL::text AS request_key, NULL::jsonb AS response,
          NULL::text AS operation_kind
        FROM iron_gate.finance_revision r
        JOIN iron_gate.finance_document d ON d.property_id=r.property_id
          AND d.id=r.document_id
        LEFT JOIN LATERAL (
          SELECT event_kind,amount_cents,safe_description
          FROM iron_gate.finance_event ev
          WHERE ev.property_id=r.property_id AND ev.document_id=r.document_id
            AND ev.revision_version=CASE WHEN r.action IN ('void','card_fail')
              THEN GREATEST(1,r.version-1) ELSE r.version END
            AND ev.event_kind<>'reversal'
          ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT amount_cents,safe_description FROM iron_gate.finance_event ev
          WHERE ev.property_id=r.property_id AND ev.document_id=r.document_id
            AND ev.revision_version=r.version-1 AND ev.event_kind<>'reversal'
          ORDER BY ev.created_at DESC,ev.id DESC LIMIT 1
        ) previous ON true
        WHERE r.property_id=$1
        UNION ALL
        SELECT a.created_at AS at,a.audit_id::text AS id,
          'operation'::text AS source,a.audit_json->>'action' AS action,
          a.audit_json->>'actorRef' AS actor_ref,
          NULL::text AS source_actor_ref,
          NULL::text AS source_recorded_at,
          COALESCE(rr.response_json->>'rule_id',rr.response_json->>'account_code',
            rr.response_json->>'category_code',rr.response_json->>'status_id',
            rr.response_json->>'platform',rr.response_json->>'settlement_id',
            rr.response_json->>'issue_id',a.audit_id::text) AS target_id,
          NULL::integer AS version,NULL::text AS source_system,
          NULL::text AS event_kind,NULL::bigint AS amount_cents,
          NULL::text AS safe_description,NULL::text AS reason_note,
          NULL::bigint AS before_amount_cents,
          NULL::text AS before_safe_description,
          a.audit_json->>'requestKey' AS request_key,rr.response_json AS response,
          a.audit_json->>'operationKind' AS operation_kind
        FROM iron_gate.audit_log a
        LEFT JOIN iron_gate.finance_request_receipt rr
          ON rr.property_id=a.property_id
          AND rr.source_instance_id=(a.audit_json->>'sourceInstanceId')::uuid
          AND rr.request_key=a.audit_json->>'requestKey'
        WHERE a.property_id=$1 AND a.audit_json->>'type'='finance.operation'
      ), mapped AS (SELECT *, CASE
        WHEN source='money' AND action='create' AND event_kind IN
          ('expense_paid','processor_fee_paid') THEN 'expense_created'
        WHEN source='money' AND action='create' THEN 'income_created'
        WHEN source='money' AND action='amend' AND event_kind IN
          ('expense_paid','processor_fee_paid') THEN 'expense_updated'
        WHEN source='money' AND action='amend' THEN 'income_updated'
        WHEN source='money' AND action='void' AND event_kind IN
          ('expense_paid','processor_fee_paid') THEN 'expense_voided'
        WHEN source='money' AND action='void' THEN 'income_voided'
        WHEN operation_kind IS NOT NULL THEN operation_kind
        WHEN response ? 'account_code' THEN 'payment_account_created'
        WHEN response ? 'category_code' THEN 'category_created'
        WHEN response ? 'rule_id' THEN 'recurring_created'
        WHEN response ? 'platform' THEN 'payout_rule_updated'
        WHEN response ? 'status_id' THEN 'calendar_payment_confirmed'
        WHEN response ? 'settlement_id' THEN 'settlement_recorded'
        WHEN action='finance:evidence' THEN 'evidence_recorded'
        WHEN action='finance:import' THEN 'historical_imported'
        ELSE 'legacy_unknown' END AS ui_action FROM activity
      ) SELECT *,count(*) OVER() AS total FROM mapped
        WHERE ($3::text='' OR ui_action=$3)
          AND ($4::text='' OR concat_ws(' ',actor_ref,at::text,target_id,
            source_system,safe_description,reason_note,request_key) ILIKE '%' || $4 || '%')
        ORDER BY at DESC,id DESC LIMIT 30 OFFSET $2`,
        [propertyId,(page-1)*30,action,query.trim()]);
      return {page,page_size:30,total:Number(rows.rows[0]?.total ?? 0),
        activities:rows.rows.map(({total,...row}) => row),
        as_of_change_seq:await financeWatermark(client,propertyId)};
    });
  }
  async historicalSettlements(principal, propertyId, asOfChangeSeq = null) {
    this.#authorize(principal,propertyId,'finance:read');
    if (asOfChangeSeq !== null && (!Number.isSafeInteger(asOfChangeSeq) ||
      asOfChangeSeq < 0)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      const {state}=await this.#context(client,principal,propertyId,false);
      const current=await financeWatermark(client,propertyId);
      const pinned=asOfChangeSeq ?? current;
      if (pinned > current) fail('VERSION_CONFLICT',409);
      const rows=await client.query(`SELECT d.id,d.property_id,d.booking_id,d.decision,
        d.booking_version,d.booking_total_cents,d.booking_snapshot_hash,
        d.source_link_snapshot_hash,d.sheet_order_source_version,
        d.cash_effect_cents,c.change_seq
        FROM iron_gate.finance_legacy_settlement d
        JOIN iron_gate.finance_change c ON c.property_id=d.property_id
          AND c.source_kind='legacy_settlement' AND c.source_id=d.id::text
          AND c.source_version='1'
        WHERE d.property_id=$1 AND c.change_seq<=$2 ORDER BY c.change_seq`,
        [propertyId,pinned]);
      const list=[];
      for (const row of rows.rows) {
        const booking=state.bookings.find(item => item.id===row.booking_id) ??
          {id:row.booking_id,version:-1,totalCents:-1,currency:'',source:'',status:''};
        const events=await client.query(`SELECT e.event_kind,
          original.event_kind AS reversed_kind,a.allocation_kind,a.amount_cents,
          ce.change_seq
          FROM iron_gate.finance_allocation a
          JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
          LEFT JOIN iron_gate.finance_event original ON original.property_id=e.property_id
            AND original.id=e.reverses_event_id
          LEFT JOIN iron_gate.finance_change_event ce ON ce.property_id=e.property_id
            AND ce.event_id=e.id
          WHERE a.property_id=$1 AND a.booking_id=$2`,[propertyId,row.booking_id]);
        const legacyEvents=booking.paymentEvents ?? [];
        const cardResults=booking.cardChargeResults ?? [];
        const legacyConflict=!Array.isArray(legacyEvents) || legacyEvents.length>0 ||
          !Array.isArray(cardResults) || cardResults.some(result =>
            String(result?.status ?? '').toLowerCase()==='done') ||
          events.rows.some(event => event.change_seq == null);
        let received=0;
        let refunded=0;
        let ota=false;
        for (const event of events.rows) {
          if (Number(event.change_seq)>pinned) continue;
          const kind=event.event_kind==='reversal' ? event.reversed_kind : event.event_kind;
          if (kind==='property_receipt' && ['room','deposit'].includes(event.allocation_kind))
            received+=Number(event.amount_cents);
          else if (kind==='property_refund' && ['room','deposit'].includes(event.allocation_kind))
            refunded+=Number(event.amount_cents);
          else if (['ota_guest_payment_observed','ota_payout'].includes(kind)) ota=true;
        }
        const baselineDue=row.decision==='unpaid_at_cutover' && booking.source==='os' &&
          !legacyConflict && !ota &&
          Number.isSafeInteger(booking.totalCents) && booking.totalCents>0 ?
          Math.max(0,booking.totalCents-received+refunded) : null;
        const pinnedEventCount=events.rows.filter(event=>event.change_seq==null ||
          Number(event.change_seq)<=pinned).length;
        const projection=historicalSettlementProjection(row,booking,baselineDue,
          pinnedEventCount,legacyConflict);
        list.push({property_id:propertyId,booking_id:row.booking_id,
          status:row.decision,booking_version:Number(row.booking_version),
          booking_total_cents:Number(row.booking_total_cents),
          booking_snapshot_hash:row.booking_snapshot_hash,
          source_link_snapshot_hash:row.source_link_snapshot_hash,cash_effect_cents:0,
          sheet_order_source_version:row.sheet_order_source_version,
          collection_hold:projection.collection_hold,
          historical_cash_detail_missing:projection.historical_cash_detail_missing,
          review_required:projection.review_required,
          remaining_due_cents:projection.remaining_due_cents,
          room_received_cents:received,room_refunded_cents:refunded,
          recorded_change_seq:Number(row.change_seq),as_of_change_seq:pinned});
      }
      return {property_id:propertyId,legacy_settlements:list,
        as_of_change_seq:pinned,current_change_seq:current};
    });
  }
  async bookingFinance(principal, propertyId, bookingId) {
    this.#authorize(principal, propertyId, 'finance:read');
    if (!UUID.test(bookingId)) fail('UNKNOWN_BOOKING', 422);
    return this.#transaction(propertyId, false, async client => {
      const { state } = await this.#context(client, principal, propertyId, false);
      const booking = state.bookings.find(b => b.id === bookingId);
      if (!booking) fail('UNKNOWN_BOOKING', 422);
      const events = await client.query(`SELECT e.id,e.document_id,e.event_kind,
        COALESCE((SELECT ea.evidence_level FROM iron_gate.finance_evidence_assertion ea
          WHERE ea.property_id=e.property_id AND ea.event_id=e.id
          ORDER BY CASE ea.evidence_level WHEN 'bank_reconciled' THEN 3
            WHEN 'processor_confirmed' THEN 2 ELSE 1 END DESC LIMIT 1),
          e.evidence_level) AS evidence_level,e.cash_on,e.effective_on,e.reverses_event_id,
        original.event_kind AS reversed_kind,a.allocation_kind,a.amount_cents
        FROM iron_gate.finance_allocation a JOIN iron_gate.finance_event e
          ON e.property_id=a.property_id AND e.id=a.event_id
        LEFT JOIN iron_gate.finance_event original
          ON original.property_id=e.property_id AND original.id=e.reverses_event_id
        WHERE a.property_id=$1 AND a.booking_id=$2
        ORDER BY e.effective_on,e.id`, [propertyId,bookingId]);
      const summary = { property_received_cents: 0, property_refunded_cents: 0,
        room_received_cents: 0, room_refunded_cents: 0,
        ota_guest_observed_cents: 0, ota_payout_cents: 0, expense_cents: 0 };
      for (const row of events.rows) {
        const kind = row.event_kind === 'reversal' ? row.reversed_kind : row.event_kind;
        // Reversal allocations are stored with a negative amount. Use the
        // booking allocation, not the whole event amount, for split receipts.
        const cents = Number(row.amount_cents);
        if (kind === 'property_receipt') {
          summary.property_received_cents += cents;
          if (['room','deposit'].includes(row.allocation_kind)) summary.room_received_cents += cents;
        } else if (kind === 'property_refund') {
          summary.property_refunded_cents += cents;
          if (['room','deposit'].includes(row.allocation_kind)) summary.room_refunded_cents += cents;
        }
        else if (kind === 'ota_guest_payment_observed') summary.ota_guest_observed_cents += cents;
        else if (kind === 'ota_payout') summary.ota_payout_cents += cents;
        else if (['expense_paid','processor_fee_paid'].includes(kind)) summary.expense_cents += cents;
      }
      const legacyEvents = booking.paymentEvents ?? [];
      const legacyIds = Array.isArray(legacyEvents) ? legacyEvents.map(e => e?.id) : [null];
      const validLegacyIds = legacyIds.filter(id => UUID.test(id ?? ''));
      const mapped = validLegacyIds.length ? await client.query(`SELECT existing_payment_event_id
        FROM iron_gate.finance_payment_ownership WHERE property_id=$1 AND booking_id=$2
          AND existing_payment_event_id=ANY($3::uuid[])`,
        [propertyId,bookingId,validLegacyIds]) :
        { rows: [] };
      const unmappedLegacyPaymentEvents = legacyIds.length - mapped.rows.length;
      const cardResults = booking.cardChargeResults ?? [];
      const cardDone = Array.isArray(cardResults) ?
        cardResults.filter(result => String(result?.status ?? '').toLowerCase() === 'done') : [null];
      const validCardEventIds = cardDone.map(result => result?.paymentEventId)
        .filter(id => UUID.test(id ?? ''));
      const mappedCardDone = validCardEventIds.length ? await client.query(`
        SELECT existing_payment_event_id FROM iron_gate.finance_payment_ownership
        WHERE property_id=$1 AND booking_id=$2 AND provider_code='sweetfun_card'
          AND existing_payment_event_id=ANY($3::uuid[])`,
        [propertyId,bookingId,validCardEventIds]) : { rows: [] };
      const unmappedCardDoneResults = cardDone.length - mappedCardDone.rows.length;
      const cardPaymentReviewRequired = unmappedCardDoneResults > 0;
      const legacyUnmapped = unmappedLegacyPaymentEvents > 0 || cardPaymentReviewRequired;
      const settlementRows = await client.query(`SELECT id,decision,booking_version,
        booking_snapshot_hash,booking_total_cents FROM iron_gate.finance_legacy_settlement
        WHERE property_id=$1 AND booking_id=$2`,[propertyId,bookingId]);
      const remaining = booking.source === 'os' && Number.isSafeInteger(booking.totalCents) &&
        !legacyUnmapped && summary.ota_guest_observed_cents === 0 &&
        summary.ota_payout_cents === 0 ?
        Math.max(0,booking.totalCents-summary.room_received_cents+
          summary.room_refunded_cents) : null;
      const legacy = historicalSettlementProjection(settlementRows.rows[0] ?? null,
        booking,remaining,events.rows.length,legacyUnmapped);
      return { property_id:propertyId, booking_id: bookingId, booking_version: booking.version,
        room_total_cents: booking.totalCents, currency: booking.currency,
        summary, remaining_due_cents: legacy.remaining_due_cents,
        legacy_settlement:legacy.legacy_settlement,
        historical_cash_detail_missing:legacy.historical_cash_detail_missing,
        collection_hold:legacy.collection_hold,
        legacy_payment_review_required: legacyUnmapped,
        unmapped_legacy_payment_events: unmappedLegacyPaymentEvents,
        card_payment_review_required: cardPaymentReviewRequired,
        unmapped_card_done_results: unmappedCardDoneResults,
        review_required: legacyUnmapped || remaining === null || legacy.review_required,
        events: events.rows.map(row => ({ ...row, effective_on: pgDay(row.effective_on),
          cash_on: pgDay(row.cash_on) })), as_of_event_id: events.rows.at(-1)?.id ?? null,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async expenses(principal, propertyId, month, limit = 50, cursor = null) {
    this.#authorize(principal, propertyId, 'finance:read');
    day(month, true);
    if (!month.endsWith('-01') || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      fail('INVALID_INPUT');
    if (cursor != null && !UUID.test(cursor)) fail('INVALID_CURSOR');
    return this.#transaction(propertyId, false, async client => {
      await this.#context(client, principal, propertyId, false);
      const rows = await client.query(`SELECT e.id,e.document_id,e.event_kind,
        e.category_code,e.cash_on,
        COALESCE((SELECT ea.evidence_level FROM iron_gate.finance_evidence_assertion ea
          WHERE ea.property_id=e.property_id AND ea.event_id=e.id
          ORDER BY CASE ea.evidence_level WHEN 'bank_reconciled' THEN 3
            WHEN 'processor_confirmed' THEN 2 ELSE 1 END DESC LIMIT 1),
          e.evidence_level) AS evidence_level,
        a.month,a.amount_cents,a.allocation_policy
        FROM iron_gate.finance_expense_attribution a JOIN iron_gate.finance_event e
          ON e.property_id=a.property_id AND e.id=a.event_id
        WHERE a.property_id=$1 AND a.month=$2::date AND ($3::uuid IS NULL OR e.id>$3::uuid)
        ORDER BY e.id LIMIT $4`, [propertyId,month,cursor,limit+1]);
      const page = rows.rows.slice(0,limit).map(row => ({ ...row,
        month: pgDay(row.month), cash_on: pgDay(row.cash_on) }));
      return { expenses: page, total_cents: page.reduce((n,row) => n+Number(row.amount_cents),0),
        next_cursor: rows.rows.length>limit ? page.at(-1)?.id : null,
        as_of_event_id: page.at(-1)?.id ?? null,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async accounts(principal, propertyId) {
    this.#authorize(principal, propertyId, 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      await this.#context(client, principal, propertyId, false);
      const result = await client.query(`SELECT id,code,display_name,kind,last_digits,status,version
        FROM iron_gate.finance_account WHERE property_id=$1 ORDER BY code`, [propertyId]);
      return { accounts: result.rows,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async categories(principal, propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT code,label,kind,status,version
        FROM iron_gate.finance_category WHERE property_id=$1 ORDER BY kind,code`,[propertyId]);
      return { categories:result.rows,
        as_of_change_seq:await financeWatermark(client,propertyId) };
    });
  }
  async accountCommand(principal, propertyId, raw, requestKey, shadowImport = false) {
    if (!shadowImport && principal.financeGeneralEntriesOnly === true)
      fail('SOURCE_FORBIDDEN',403);
    const keys = new Set(['request_key','code','display_name','kind','last_digits',
      'origin_request_hash','source_actor_ref','source_recorded_at',
      'origin_source_version']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,64}$/.test(raw.code ?? '') ||
      typeof raw.display_name !== 'string' || !raw.display_name.trim() ||
      raw.display_name.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.display_name) ||
      !['card','bank'].includes(raw.kind) ||
      !(raw.kind === 'card' ? /^[0-9]{4}$/ : /^[0-9]{5}$/).test(raw.last_digits ?? ''))
      fail('INVALID_INPUT');
    if (shadowImport) {
      assertImportCatalogProvenance(raw);
      if (raw.display_name !== raw.display_name.trim()) fail('INVALID_INPUT');
    }
    return this.#operation(principal,propertyId,
      shadowImport ? 'finance:import' : 'finance:plan',raw,requestKey,
      async (client,{source}) => {
        if (shadowImport && source.source_system !== 'os_manual')
          fail('SOURCE_FORBIDDEN',403);
        const existing = await client.query(`SELECT 1 FROM iron_gate.finance_account
          WHERE property_id=$1 AND code=$2`,[propertyId,raw.code]);
        if (existing.rows.length) fail('ACCOUNT_EXISTS',409);
        const id = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_account
          (id,property_id,code,display_name,kind,last_digits)
          VALUES ($1,$2,$3,$4,$5,$6)`,[id,propertyId,raw.code,
            raw.display_name.trim(),raw.kind,raw.last_digits]);
        if (shadowImport) await this.#recordImportCatalog(client,principal,propertyId,
          'account',raw.code,1,raw.code,raw);
        return {receipt_status:'accepted',request_key:requestKey,account_id:id,
          account_code:raw.code,cash_effect_cents:0};
      },shadowImport);
  }
  async categoryCommand(principal, propertyId, raw, requestKey, shadowImport = false) {
    if (!shadowImport && principal.financeGeneralEntriesOnly === true &&
      !/^custom_[a-z0-9_]{1,57}$/.test(raw?.code ?? ''))
      fail('SOURCE_FORBIDDEN',403);
    const keys = new Set(['request_key','code','label','kind','origin_request_hash',
      'source_actor_ref','source_recorded_at','origin_source_version']);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some(key => !keys.has(key)) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.code ?? '') ||
      typeof raw.label !== 'string' || !raw.label.trim() ||
      raw.label.length > 128 || /[\u0000-\u001f\u007f]/.test(raw.label) ||
      !['income','expense'].includes(raw.kind)) fail('INVALID_INPUT');
    if (shadowImport) {
      assertImportCatalogProvenance(raw);
      if (raw.label !== raw.label.trim()) fail('INVALID_INPUT');
    }
    return this.#operation(principal,propertyId,
      shadowImport ? 'finance:import' : 'finance:plan',raw,requestKey,
      async (client,{source}) => {
        if (shadowImport && source.source_system !== 'os_manual')
          fail('SOURCE_FORBIDDEN',403);
        const existing = await client.query(`SELECT 1 FROM iron_gate.finance_category
          WHERE property_id=$1 AND kind=$2 AND code=$3`,[propertyId,raw.kind,raw.code]);
        if (existing.rows.length) fail('CATEGORY_EXISTS',409);
        await client.query(`INSERT INTO iron_gate.finance_category
          (property_id,kind,code,label) VALUES ($1,$2,$3,$4)`,
          [propertyId,raw.kind,raw.code,raw.label.trim()]);
        if (shadowImport) await this.#recordImportCatalog(client,principal,propertyId,
          'category',`${raw.kind}:${raw.code}`,1,`${raw.kind}:${raw.code}`,raw);
        return {receipt_status:'accepted',request_key:requestKey,
          category_code:raw.code,cash_effect_cents:0};
      },shadowImport);
  }
  async command(principal, propertyId, raw, requestKey, shadowImport = false) {
    const command = normalize(raw, requestKey);
    if (!shadowImport) assertGeneralEntryCommand(principal,command);
    const action = command.action === 'void' || command.action === 'amend' ? 'finance:correct' :
      command.event_kind === 'property_refund' ? 'finance:refund' :
      ['expense_paid', 'processor_fee_paid'].includes(command.event_kind) ?
        'finance:record_expense' : 'finance:record_receipt';
    this.#authorize(principal, propertyId, shadowImport ? 'finance:import' : action);
    if (!shadowImport && (command.source_actor_ref || command.source_recorded_at))
      fail('INVALID_INPUT');
    const requestHash = hash(command);
    return this.#transaction(propertyId, true, async client => {
      const { state, source } = await this.#context(client, principal, propertyId, true, shadowImport);
      if (source.source_system === 'sheet_bulk' &&
        (!source.source_sheet_ref || !command.source_record_id.startsWith(
          `sheet:${source.source_sheet_ref}:`) || !UUID.test(command.source_record_id.slice(
            `sheet:${source.source_sheet_ref}:`.length)))) fail('SOURCE_FORBIDDEN',403);
      const observed = ['ota_payout','ota_guest_payment_observed'].includes(command.event_kind);
      if (command.action !== 'void' &&
        (observed ? source.source_system !== 'ota_evidence' || !command.evidence_ref ||
          command.evidence_level !== 'provider_notice' :
          command.evidence_level !== 'operator_attested'))
        fail('SOURCE_FORBIDDEN',403);
      if (command.action !== 'void' && command.cash_on &&
        command.cash_on > todayTaipei()) fail('FUTURE_RECEIPT',422);
      const priorReceipt = await client.query(`SELECT request_hash,response_json
        FROM iron_gate.finance_request_receipt WHERE property_id=$1 AND source_instance_id=$2 AND request_key=$3`,
        [propertyId, principal.financeSourceInstanceId, requestKey]);
      if (priorReceipt.rows.length) {
        if (priorReceipt.rows[0].request_hash !== requestHash) fail('REQUEST_KEY_REUSED', 409);
        return priorReceipt.rows[0].response_json;
      }
      if (!shadowImport)
        await this.#assertGeneralDocument(client,principal,propertyId,command);
      if (shadowImport && !command.source_recorded_at)
        fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      // A payment method is not a verified processor identity. Until a
      // connector supplies one, a caller-provided transaction reference cannot
      // safely claim the cross-source uniqueness key.
      if (command.action === 'create' && command.provider_transaction_ref)
        fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      await this.#assertVoidGuards(client,principal,propertyId,command);
      const bookings = this.#bookings(state, command);
      if (bookings.length) this.#verifyToken(raw.preview_token, principal, propertyId, command, bookings);
      if (bookings.length) {
        const historicallySettled=await client.query(`SELECT 1
          FROM iron_gate.finance_legacy_settlement
          WHERE property_id=$1 AND booking_id=ANY($2::uuid[])
            AND decision='settled_before_cutover_cash_details_unknown' LIMIT 1`,
          [propertyId,bookings.map(item => item.bookingId)]);
        if (historicallySettled.rows.length) fail('HISTORICAL_SETTLEMENT_REVIEW_REQUIRED',409);
      }
      for (const a of command.booking_allocations) if (a.source_order_key != null) {
        const linked = await client.query(`SELECT 1 FROM iron_gate.finance_source_link
          WHERE property_id=$1 AND source_instance_id=$2 AND source_order_key=$3
            AND booking_id=$4 AND source_snapshot_hash=$5
            AND verified_booking_version=$6`,
          [propertyId,principal.financeSourceInstanceId,a.source_order_key,
            a.booking_id,a.source_snapshot_hash,a.expected_booking_version]);
        if (linked.rows.length !== 1) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      }
      const existing = await client.query(`SELECT id,current_version,status FROM iron_gate.finance_document
        WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
        [propertyId, principal.financeSourceInstanceId, command.source_record_id]);
      if (command.action === 'create' && existing.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
      if (command.action === 'create') {
        const alias = await client.query(`SELECT 1 FROM iron_gate.finance_source_alias
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
          [propertyId, principal.financeSourceInstanceId, command.source_record_id]);
        if (alias.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
      }
      if (command.action !== 'create' && (!existing.rows.length || existing.rows[0].status !== 'active' ||
        existing.rows[0].current_version !== command.expected_version)) fail('VERSION_CONFLICT', 409);
      const documentId = existing.rows[0]?.id ?? randomUUID();
      const version = (existing.rows[0]?.current_version ?? 0) + 1;
      if (command.action === 'amend') {
        const owned = await client.query(`SELECT provider_code,provider_transaction_ref,
          booking_id FROM iron_gate.finance_payment_ownership
          WHERE property_id=$1 AND canonical_document_id=$2 AND
            provider_transaction_ref IS NOT NULL`, [propertyId,documentId]);
        if (owned.rows.length > 1 ||
          owned.rows.length && (command.payment_method_code !== owned.rows[0].provider_code ||
            command.booking_allocations.length !== 1 ||
            command.booking_allocations[0].booking_id !== owned.rows[0].booking_id ||
            command.provider_transaction_ref != null &&
              command.provider_transaction_ref !== owned.rows[0].provider_transaction_ref) ||
          !owned.rows.length && command.provider_transaction_ref)
          fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
      }
      if (command.action !== 'create') {
        const priorKind = await client.query(`SELECT event_kind,related_receipt_document_id,
          related_receipt_event_id FROM iron_gate.finance_event
          WHERE property_id=$1 AND document_id=$2 AND revision_version=$3 AND event_kind<>'reversal'`,
          [propertyId, documentId, version - 1]);
        if (priorKind.rows.length !== 1 ||
          (command.action === 'amend' && command.event_kind !== priorKind.rows[0].event_kind))
          fail('VERSION_CONFLICT', 409);
        if (command.action === 'amend' && command.event_kind === 'property_refund' &&
          (command.related_receipt_document_id !== priorKind.rows[0].related_receipt_document_id ||
            command.related_receipt_event_id !== priorKind.rows[0].related_receipt_event_id))
          fail('VERSION_CONFLICT',409);
        if (priorKind.rows[0].event_kind === 'property_refund' &&
          !principal.actions.includes('finance:refund')) fail('PROPERTY_FORBIDDEN',403);
        // A settlement names exact event IDs and amounts. Replacing a settled
        // event would leave the bank batch pointing at an obsolete revision.
        const settled = await client.query(`SELECT 1 FROM iron_gate.finance_settlement_link l
          JOIN iron_gate.finance_event e ON e.property_id=l.property_id AND e.id=l.event_id
          WHERE e.property_id=$1 AND e.document_id=$2 AND e.revision_version=$3
          LIMIT 1`, [propertyId,documentId,version-1]);
        if (settled.rows.length) fail('SETTLEMENT_REVIEW_REQUIRED',409);
      }
      if (command.action !== 'void' && command.payment_account_ref) {
        const account = await client.query(`SELECT 1 FROM iron_gate.finance_account
          WHERE property_id=$1 AND code=$2 AND status='active' AND
            ((kind='card' AND $3='credit_card') OR
             (kind='bank' AND $3='bank_transfer') OR
             (kind='cash' AND $3='cash') OR
             (kind='other' AND $3='other'))`,
          [propertyId, command.payment_account_ref,command.payment_method_code]);
        if (!account.rows.length) fail('INVALID_ACCOUNT', 422);
      }
      if (command.action !== 'void' && command.category_code) {
        const categoryKind = ['expense_paid','processor_fee_paid'].includes(command.event_kind) ?
          'expense' : 'income';
        const category = await client.query(`SELECT 1 FROM iron_gate.finance_category
          WHERE property_id=$1 AND kind=$2 AND code=$3 AND status='active'`,
          [propertyId,categoryKind,command.category_code]);
        if (!category.rows.length) fail('INVALID_CATEGORY', 422);
      }
      if (command.action !== 'void' && command.event_kind === 'property_refund') {
        const original = await client.query(`SELECT e.id,e.amount_cents,d.current_version,
          d.status,d.source_system
          FROM iron_gate.finance_document d JOIN iron_gate.finance_event e
          ON e.property_id=d.property_id AND e.document_id=d.id AND
             e.revision_version=d.current_version
          WHERE d.property_id=$1 AND d.id=$2 AND
            e.event_kind='property_receipt'`, [propertyId,
            command.related_receipt_document_id]);
        if (!original.rows.length || original.rows[0].status !== 'active') fail('REFUND_LIMIT', 422);
        if (original.rows[0].id !== command.related_receipt_event_id) {
          if (command.action !== 'amend') fail('VERSION_CONFLICT',409);
          const historical = await client.query(`SELECT 1 FROM iron_gate.finance_event
            WHERE property_id=$1 AND document_id=$2 AND id=$3
              AND event_kind='property_receipt'`, [propertyId,
              command.related_receipt_document_id,command.related_receipt_event_id]);
          if (historical.rows.length !== 1) fail('VERSION_CONFLICT',409);
        }
        // Native and Card receipts retain a separate booking JSON read path.
        // Their refunds require an atomic compatibility projection.
        if (['sweetfun_card','iron_gate_native'].includes(original.rows[0].source_system))
          fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        const originalAllocations = await client.query(`SELECT booking_id,amount_cents,allocation_kind
          FROM iron_gate.finance_allocation WHERE property_id=$1 AND event_id=$2`,
          [propertyId, original.rows[0].id]);
        if (command.booking_allocations.some(a => !originalAllocations.rows.some(o =>
            o.booking_id === a.booking_id && o.allocation_kind === a.allocation_kind &&
            a.amount_cents <= Number(o.amount_cents)))) fail('ALLOCATION_MISMATCH', 422);
        for (const a of command.booking_allocations) {
          const previous = await client.query(`SELECT COALESCE(sum(fa.amount_cents),0)::bigint AS total
            FROM iron_gate.finance_allocation fa
            JOIN iron_gate.finance_event fe ON fe.property_id=fa.property_id AND fe.id=fa.event_id
            JOIN iron_gate.finance_document fd ON fd.property_id=fe.property_id AND fd.id=fe.document_id
            WHERE fa.property_id=$1 AND fa.booking_id=$2 AND fa.allocation_kind=$3
              AND fe.event_kind='property_refund' AND fe.related_receipt_document_id=$4
              AND fe.revision_version=fd.current_version AND fd.status='active' AND fd.id<>$5`,
            [propertyId, a.booking_id, a.allocation_kind,
              command.related_receipt_document_id, documentId]);
          const originalAmount = Number(originalAllocations.rows.find(o =>
            o.booking_id === a.booking_id && o.allocation_kind === a.allocation_kind).amount_cents);
          if (Number(previous.rows[0].total) + a.amount_cents > originalAmount)
            fail('REFUND_LIMIT', 422);
        }
        const refunds = await client.query(`SELECT COALESCE(sum(e.amount_cents),0)::bigint AS total
          FROM iron_gate.finance_event e JOIN iron_gate.finance_document d
          ON d.property_id=e.property_id AND d.id=e.document_id AND
            d.current_version=e.revision_version
          WHERE e.property_id=$1 AND d.status='active' AND e.event_kind='property_refund'
            AND e.related_receipt_document_id=$2 AND d.id<>$3`,
          [propertyId, command.related_receipt_document_id, documentId]);
        if (Number(refunds.rows[0].total) + command.amount_cents > Number(original.rows[0].amount_cents))
          fail('REFUND_LIMIT', 422);
      }
      if (command.action !== 'create') {
        const activeRefunds = await client.query(`SELECT COALESCE(sum(e.amount_cents),0)::bigint AS total
          FROM iron_gate.finance_event e JOIN iron_gate.finance_document d
          ON d.property_id=e.property_id AND d.id=e.document_id AND
            d.current_version=e.revision_version
          WHERE e.property_id=$1 AND d.status='active' AND e.event_kind='property_refund'
            AND e.related_receipt_document_id=$2`, [propertyId, documentId]);
        if (Number(activeRefunds.rows[0].total) > (command.action === 'void' ? 0 :
          command.event_kind === 'property_receipt' ? command.amount_cents : MAX_AMOUNT))
          fail('REFUND_LIMIT', 422);
        if (command.action === 'amend' && command.event_kind === 'property_receipt') {
          const refundedAllocations = await client.query(`SELECT a.booking_id,a.allocation_kind,
            sum(a.amount_cents)::bigint AS total
            FROM iron_gate.finance_allocation a
            JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
            JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
            WHERE e.property_id=$1 AND e.event_kind='property_refund'
              AND e.related_receipt_document_id=$2
              AND e.revision_version=d.current_version AND d.status='active'
            GROUP BY a.booking_id,a.allocation_kind`,[propertyId,documentId]);
          if (refundedAllocations.rows.some(row =>
            Number(row.total) > (command.booking_allocations.find(a =>
              a.booking_id === row.booking_id &&
                a.allocation_kind === row.allocation_kind)?.amount_cents ?? 0)))
            fail('REFUND_LIMIT',422);
        }
      }
      if (command.action === 'create' && command.event_kind === 'property_receipt') {
        for (const allocation of command.booking_allocations) {
          const suspected = await client.query(`SELECT 1 FROM iron_gate.finance_allocation a
            JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
            JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
            WHERE a.property_id=$1 AND a.booking_id=$2 AND a.amount_cents=$3
              AND e.event_kind='property_receipt' AND
                e.effective_on BETWEEN ($4::date - 3) AND ($4::date + 3)
              AND e.revision_version=d.current_version AND d.status='active'
            LIMIT 1`, [propertyId, allocation.booking_id, allocation.amount_cents,
              command.effective_on]);
          if (suspected.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        }
      }
      if (command.action !== 'void' && command.event_kind === 'property_receipt' &&
        ['room','deposit'].includes(command.receipt_purpose)) {
        for (const allocation of command.booking_allocations) {
          const booking = state.bookings.find(b => b.id === allocation.booking_id);
          if (!Number.isSafeInteger(booking.totalCents) || booking.totalCents <= 0 ||
            (booking.source !== 'os' && !allocation.source_order_key &&
              !['line_finance','sheet_bulk'].includes(source.source_system)))
            fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
          await this.#assertLegacyPaymentsMapped(client,propertyId,booking);
          const current = await client.query(`SELECT COALESCE(sum(CASE
              WHEN e.event_kind='property_refund' THEN -a.amount_cents
              WHEN e.event_kind='reversal' AND original.event_kind='property_refund'
                THEN -a.amount_cents ELSE a.amount_cents END),0)::bigint AS total
            FROM iron_gate.finance_allocation a JOIN iron_gate.finance_event e
              ON e.property_id=a.property_id AND e.id=a.event_id
            LEFT JOIN iron_gate.finance_event original
              ON original.property_id=e.property_id AND original.id=e.reverses_event_id
            WHERE a.property_id=$1 AND a.booking_id=$2 AND a.allocation_kind IN ('room','deposit') AND
              (e.event_kind IN ('property_receipt','property_refund') OR
               (e.event_kind='reversal' AND original.event_kind IN ('property_receipt','property_refund')))
              AND e.document_id<>$3`, [propertyId, allocation.booking_id, documentId]);
          if (Number(current.rows[0].total) + allocation.amount_cents > booking.totalCents)
            fail('ALLOCATION_MISMATCH', 422);
        }
      }
      if (command.action === 'create') await client.query(`INSERT INTO iron_gate.finance_document
        (id,property_id,source_instance_id,source_system,source_record_id,kind,current_version,status)
        VALUES ($1,$2,$3,$4,$5,$6,1,'active')`, [documentId, propertyId,
        principal.financeSourceInstanceId, source.source_system, command.source_record_id,
        command.event_kind === 'ota_guest_payment_observed' ? 'observation' : 'money']);
      else await client.query(`UPDATE iron_gate.finance_document SET current_version=$1,
        status=$2,updated_at=now() WHERE property_id=$3 AND id=$4`,
        [version, command.action === 'void' ? 'void' : 'active', propertyId, documentId]);
      await client.query(`INSERT INTO iron_gate.finance_revision
        (property_id,document_id,version,action,request_hash,source_version,
         actor_ref,source_actor_ref,source_recorded_at,reason_code,reason_note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [propertyId, documentId, version,
        command.action, requestHash, command.source_version, principal.subjectId,
        command.source_actor_ref ?? null,command.source_recorded_at ?? null,
        command.reason_code,command.reason_note]);
      const eventIds = [];
      // Reversal and replacement share one revision and one serializable transaction.
      if (command.action !== 'create') {
        const currentEvents = await client.query(`SELECT * FROM iron_gate.finance_event
          WHERE property_id=$1 AND document_id=$2 AND revision_version=$3 AND event_kind<>'reversal'`,
          [propertyId, documentId, version - 1]);
        for (const event of currentEvents.rows) {
          const reversalId = randomUUID();
          await client.query(`INSERT INTO iron_gate.finance_event
            (id,property_id,document_id,revision_version,event_kind,amount_cents,cash_effect_cents,
             effective_on,cash_on,service_on,category_code,category_kind,receipt_purpose,
             payment_method_code,payment_account_ref,advanced_by_ref,advanced_by_kind,
             advanced_by_label,safe_description,evidence_level,evidence_ref,
             reverses_event_id,actor_ref,source_recorded_at)
            VALUES ($1,$2,$3,$4,'reversal',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [reversalId, propertyId, documentId, version, event.amount_cents,
              -Number(event.cash_effect_cents), event.effective_on, event.cash_on,
              event.service_on, event.category_code, event.category_kind, event.receipt_purpose,
              event.payment_method_code, event.payment_account_ref, event.advanced_by_ref,
              event.advanced_by_kind,event.advanced_by_label,event.safe_description,
              event.evidence_level, event.evidence_ref, event.id,
              principal.subjectId,command.source_recorded_at ?? null]);
          await client.query(`INSERT INTO iron_gate.finance_allocation
            (property_id,event_id,booking_id,amount_cents,allocation_kind)
            SELECT property_id,$1,booking_id,-amount_cents,allocation_kind FROM iron_gate.finance_allocation
            WHERE property_id=$2 AND event_id=$3`, [reversalId, propertyId, event.id]);
          await client.query(`INSERT INTO iron_gate.finance_expense_attribution
            (property_id,event_id,month,amount_cents,allocation_policy)
            SELECT property_id,$1,month,-amount_cents,allocation_policy FROM iron_gate.finance_expense_attribution
            WHERE property_id=$2 AND event_id=$3`, [reversalId, propertyId, event.id]);
          eventIds.push(reversalId);
        }
      }
      if (command.action !== 'void') {
        const eventId = randomUUID();
        const kind = command.event_kind;
        const cashEffect = kind === 'ota_guest_payment_observed' ? 0 :
          ['property_refund', 'expense_paid', 'processor_fee_paid'].includes(kind) ?
            -command.amount_cents : command.amount_cents;
        await client.query(`INSERT INTO iron_gate.finance_event
          (id,property_id,document_id,revision_version,event_kind,amount_cents,cash_effect_cents,
           effective_on,cash_on,service_on,category_code,category_kind,receipt_purpose,
           payment_method_code,payment_account_ref,advanced_by_ref,advanced_by_kind,
           advanced_by_label,safe_description,evidence_level,evidence_ref,
           related_receipt_document_id,related_receipt_event_id,actor_ref,source_recorded_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
          [eventId, propertyId, documentId, version, kind, command.amount_cents, cashEffect,
            command.effective_on, command.cash_on, command.service_on, command.category_code,
            command.category_code ?
              ['expense_paid','processor_fee_paid'].includes(kind) ? 'expense' : 'income' : null,
            command.receipt_purpose, command.payment_method_code, command.payment_account_ref,
            command.advanced_by_ref,command.advanced_by_kind,command.advanced_by_label,
            command.safe_description, command.evidence_level,command.evidence_ref,
            command.related_receipt_document_id,
            command.related_receipt_event_id, principal.subjectId,
            command.source_recorded_at ?? null]);
        for (const a of command.booking_allocations) await client.query(`INSERT INTO iron_gate.finance_allocation
          (property_id,event_id,booking_id,amount_cents,allocation_kind) VALUES ($1,$2,$3,$4,$5)`,
          [propertyId, eventId, a.booking_id, a.amount_cents, a.allocation_kind]);
        for (const a of command.expense_attributions) await client.query(`INSERT INTO iron_gate.finance_expense_attribution
          (property_id,event_id,month,amount_cents,allocation_policy) VALUES ($1,$2,$3,$4,$5)`,
          [propertyId, eventId, a.month, a.amount_cents, a.allocation_policy]);
        eventIds.push(eventId);
      }
      const changeSeq = await appendFinanceChange(client,propertyId,
        'document_revision',documentId,String(version));
      await linkFinanceEvents(client,propertyId,changeSeq,eventIds);
      const receipt = { receipt_status: 'accepted', document_id: documentId,
        document_version: version, event_ids: eventIds, request_key: requestKey,
        ...(command.origin_request_hash ? { origin_request_hash: command.origin_request_hash } : {}),
        as_of_change_seq: changeSeq,
        as_of_event_id: eventIds.at(-1) ?? null };
      await client.query(`INSERT INTO iron_gate.finance_request_receipt
        (property_id,source_instance_id,request_key,request_hash,status,response_json)
        VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
        [propertyId, principal.financeSourceInstanceId, requestKey, requestHash, JSON.stringify(receipt)]);
      return receipt;
    });
  }
}
