import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GateError } from './errors.ts';

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
  'action', 'event_kind', 'amount_cents', 'currency', 'effective_on', 'cash_on', 'service_on',
  'category_code', 'receipt_purpose', 'payment_method_code', 'payment_account_ref',
  'advanced_by_ref', 'safe_description', 'evidence_level', 'evidence_ref',
  'booking_allocations', 'expense_attributions', 'related_receipt_document_id',
  'related_receipt_event_id', 'reason_code', 'preview_token','provider_transaction_ref']);

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
function base64(value) { return Buffer.from(value).toString('base64url'); }
function pgDay(value) { return value instanceof Date ? value.toISOString().slice(0,10) : value; }
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
  if (action !== 'void' && (expense !== Boolean(raw.category_code) ||
    (expense && !safeText(raw.category_code, 64, true)))) fail('INVALID_INPUT');
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
    safe_description: safeText(raw.safe_description, 500),
    evidence_level: level, evidence_ref: safeText(raw.evidence_ref, 256),
    booking_allocations: allocations, expense_attributions: attributions,
    related_receipt_document_id: raw.related_receipt_document_id ?? null,
    related_receipt_event_id: raw.related_receipt_event_id ?? null,
    provider_transaction_ref: safeText(raw.provider_transaction_ref,128),
    reason_code: safeText(raw.reason_code, 64),
  };
  if (command.safe_description && /(?:\d[ -]?){13,19}|@|\+?\d{9,}/.test(command.safe_description))
    fail('UNSAFE_DESCRIPTION', 422);
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(command.source_record_id) ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(command.request_key)) fail('INVALID_INPUT');
  for (const opaque of [command.evidence_ref, command.advanced_by_ref,
    command.provider_transaction_ref])
    if (opaque != null && (!/^[A-Za-z0-9._:-]{1,256}$/.test(opaque) ||
      /\d{13,19}/.test(opaque))) fail('INVALID_INPUT');
  return command;
}

export class FinanceCommandService {
  #pool; #secret; #enabled;
  constructor(pool, secret, enabled = false) {
    this.#pool = pool;
    this.#secret = secret;
    this.#enabled = enabled && typeof secret === 'string' && secret.length >= 32;
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
        await client.query(write ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN READ ONLY');
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
  async #context(client, principal, propertyId, write) {
    const stateResult = await client.query(`SELECT state_json, workspace_id, authority_epoch
      FROM iron_gate.property_state WHERE property_id=$1 ${write ? 'FOR UPDATE' : ''}`, [propertyId]);
    const row = stateResult.rows[0];
    if (!row || row.workspace_id !== principal.workspaceId) fail('PROPERTY_FORBIDDEN', 403);
    if (write && (Number(row.authority_epoch) !== principal.authorityEpoch || row.state_json.readOnly))
      fail('AUTHORITY_MOVED', 409);
    const connector = await client.query(`SELECT source_system,source_account_ref,enabled,cutover_at
      FROM iron_gate.finance_connector WHERE property_id=$1 AND source_instance_id=$2`,
      [propertyId, principal.financeSourceInstanceId]);
    const source = connector.rows[0];
    const originAllowed = principal.origin === 'os' ? source?.source_system === 'os_manual' :
      principal.origin === 'line' ? source?.source_system === 'line_finance' :
      principal.origin === 'finance' ? ['sheet_bulk','ota_evidence'].includes(source?.source_system) : false;
    if (!source || !source.enabled || !originAllowed || (write && (!source.cutover_at ||
      Date.parse(source.cutover_at) > Date.now())))
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
    return command.booking_allocations.map(a => {
      const booking = state.bookings.find(b => b.id === a.booking_id);
      if (!booking || booking.propertyId !== state.propertyId) fail('UNKNOWN_BOOKING', 422);
      if (booking.version !== a.expected_booking_version) fail('VERSION_CONFLICT', 409);
      if (booking.status !== 'confirmed') fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
      return { bookingId: booking.id, version: booking.version, snapshotHash: hash({
        id: booking.id, version: booking.version, totalCents: booking.totalCents,
        currency: booking.currency, source: booking.source, status: booking.status,
        sourceCalendar: booking.sourceCalendar ?? null,
      }) };
    });
  }
  async preview(principal, propertyId, raw, requestKey) {
    this.#authorize(principal, propertyId, 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      const { state } = await this.#context(client, principal, propertyId, false);
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
      const bookings = this.#bookings(state, command);
      return { bookings, preview_token: bookings.length ? this.#token(principal, propertyId, command, bookings) : null,
        command_hash: hash(command), resolved_command: command };
    });
  }
  async receipt(principal, propertyId, requestKey) {
    this.#authorize(principal, propertyId, 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      await this.#context(client, principal, propertyId, false);
      const result = await client.query(`SELECT response_json FROM iron_gate.finance_request_receipt
        WHERE property_id=$1 AND source_instance_id=$2 AND request_key=$3`,
        [propertyId, principal.financeSourceInstanceId, requestKey]);
      if (!result.rows.length) fail('REQUEST_NOT_FOUND', 404);
      return result.rows[0].response_json;
    });
  }
  async #operation(principal, propertyId, action, raw, requestKey, fn) {
    this.#authorize(principal, propertyId, action);
    if (!raw || Array.isArray(raw) || typeof raw !== 'object' ||
      raw.request_key !== requestKey || !/^[A-Za-z0-9._:-]{1,256}$/.test(requestKey))
      fail('INVALID_INPUT');
    const requestHash = hash(raw);
    return this.#transaction(propertyId, true, async client => {
      const context = await this.#context(client, principal, propertyId, true);
      const previous = await client.query(`SELECT request_hash,response_json
        FROM iron_gate.finance_request_receipt WHERE property_id=$1 AND source_instance_id=$2
          AND request_key=$3`, [propertyId,principal.financeSourceInstanceId,requestKey]);
      if (previous.rows.length) {
        if (previous.rows[0].request_hash !== requestHash) fail('REQUEST_KEY_REUSED',409);
        return previous.rows[0].response_json;
      }
      const response = await fn(client,context);
      const auditId = randomUUID();
      await client.query(`INSERT INTO iron_gate.audit_log
        (audit_id,property_id,audit_json) VALUES ($1,$2,$3::jsonb)`,
        [auditId,propertyId,JSON.stringify({ auditId, propertyId,
          type:'finance.operation',action,requestKey,requestHash,
          sourceInstanceId:principal.financeSourceInstanceId,
          actorRef:principal.subjectId,at:new Date().toISOString() })]);
      await client.query(`INSERT INTO iron_gate.finance_request_receipt
        (property_id,source_instance_id,request_key,request_hash,status,response_json)
        VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
        [propertyId,principal.financeSourceInstanceId,requestKey,requestHash,JSON.stringify(response)]);
      return response;
    });
  }
  async statusCommand(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','source_record_id','version','status_code',
      'settles_room','booking_id','expected_booking_version']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.source_record_id ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.status_code ?? '') ||
      typeof raw.settles_room !== 'boolean' ||
      (raw.settles_room && !UUID.test(raw.booking_id ?? '')) ||
      (raw.booking_id != null && !UUID.test(raw.booking_id))) fail('INVALID_INPUT');
    return this.#operation(principal,propertyId,'finance:status',raw,requestKey,
      async (client,{state}) => {
        if (raw.booking_id) {
          const booking = state.bookings.find(b => b.id === raw.booking_id);
          if (!booking) fail('UNKNOWN_BOOKING',422);
          if (booking.version !== raw.expected_booking_version) fail('VERSION_CONFLICT',409);
        }
        const prior = await client.query(`SELECT max(version)::int AS version
          FROM iron_gate.finance_operational_status
          WHERE property_id=$1 AND source_instance_id=$2 AND source_record_id=$3`,
          [propertyId,principal.financeSourceInstanceId,raw.source_record_id]);
        if (raw.version !== (prior.rows[0].version ?? 0)+1) fail('VERSION_CONFLICT',409);
        const statusId = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_operational_status
          (id,property_id,booking_id,source_instance_id,source_record_id,
           version,status_code,settles_room)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [statusId,propertyId,raw.booking_id ?? null,principal.financeSourceInstanceId,
            raw.source_record_id,raw.version,raw.status_code,raw.settles_room]);
        await client.query(`INSERT INTO iron_gate.finance_outbox
          (id,property_id,source_kind,source_id,destination)
          VALUES ($1,$2,'operational_status',$3,'sheet')`,
          [randomUUID(),propertyId,statusId]);
        return { receipt_status:'accepted',request_key:requestKey,status_id:statusId,
          version:raw.version,cash_effect_cents:0 };
      });
  }
  async statuses(principal, propertyId, bookingId = null) {
    this.#authorize(principal,propertyId,'finance:read');
    if (bookingId != null && !UUID.test(bookingId)) fail('INVALID_INPUT');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT id,booking_id,source_record_id,version,
        status_code,settles_room,recorded_at FROM iron_gate.finance_operational_status
        WHERE property_id=$1 AND ($2::uuid IS NULL OR booking_id=$2::uuid)
        ORDER BY recorded_at DESC,id DESC LIMIT 100`, [propertyId,bookingId]);
      return { statuses:result.rows, cash_effect_cents:0 };
    });
  }
  async recurringRule(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','source_record_id','version','cadence','start_on',
      'end_on','next_due_on','status','category_code']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(raw?.source_record_id ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !['weekly','monthly','yearly'].includes(raw.cadence) ||
      !['active','paused','ended'].includes(raw.status) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw.category_code ?? '')) fail('INVALID_INPUT');
    const start = day(raw.start_on,true), end = day(raw.end_on), next = day(raw.next_due_on);
    if (end && end < start || next && (next < start || end && next > end)) fail('INVALID_DATE');
    return this.#operation(principal,propertyId,'finance:plan',raw,requestKey,
      async client => {
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
            status=$6,category_code=$7 WHERE property_id=$8 AND id=$9`,
          [raw.version,raw.cadence,start,end,next,raw.status,raw.category_code,propertyId,id]);
        else await client.query(`INSERT INTO iron_gate.finance_recurring_rule
          (id,property_id,source_instance_id,source_record_id,version,cadence,
           start_on,end_on,next_due_on,status,category_code)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id,propertyId,principal.financeSourceInstanceId,raw.source_record_id,
            raw.version,raw.cadence,start,end,next,raw.status,raw.category_code]);
        const outboxId = randomUUID();
        await client.query(`INSERT INTO iron_gate.finance_outbox
          (id,property_id,source_kind,source_id,destination)
          VALUES ($1,$2,'recurring_rule',$3,'sheet')`, [randomUUID(),propertyId,outboxId]);
        return { receipt_status:'accepted',request_key:requestKey,rule_id:id,
          version:raw.version,cash_effect_cents:0 };
      });
  }
  async recurringRules(principal, propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT id,source_record_id,version,cadence,
        start_on,end_on,next_due_on,status,category_code FROM iron_gate.finance_recurring_rule
        WHERE property_id=$1 ORDER BY id LIMIT 1000`, [propertyId]);
      return { recurring_rules:result.rows, cash_effect_cents:0 };
    });
  }
  async payoutRule(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','platform','version','mode','day','offset_days','status']);
    if (Object.keys(raw ?? {}).some(key => !keys.has(key)) ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(raw?.platform ?? '') ||
      !Number.isSafeInteger(raw.version) || raw.version < 1 ||
      !['fixed_day','offset_days','manual'].includes(raw.mode) ||
      !['active','disabled'].includes(raw.status) ||
      (raw.mode === 'fixed_day' ? !Number.isSafeInteger(raw.day) || raw.day < 1 ||
        raw.day > 31 || raw.offset_days != null : raw.mode === 'offset_days' ?
        !Number.isSafeInteger(raw.offset_days) || raw.offset_days < 0 ||
        raw.offset_days > 90 || raw.day != null : raw.day != null || raw.offset_days != null))
      fail('INVALID_INPUT');
    return this.#operation(principal,propertyId,'finance:plan',raw,requestKey,
      async client => {
        const prior = await client.query(`SELECT version FROM iron_gate.finance_payout_rule
          WHERE property_id=$1 AND platform=$2`, [propertyId,raw.platform]);
        if (raw.version !== (prior.rows[0]?.version ?? 0)+1) fail('VERSION_CONFLICT',409);
        if (prior.rows.length) await client.query(`UPDATE iron_gate.finance_payout_rule
          SET version=$1,mode=$2,day=$3,offset_days=$4,status=$5
          WHERE property_id=$6 AND platform=$7`,
          [raw.version,raw.mode,raw.day ?? null,raw.offset_days ?? null,
            raw.status,propertyId,raw.platform]);
        else await client.query(`INSERT INTO iron_gate.finance_payout_rule
          (property_id,platform,mode,day,offset_days,version,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [propertyId,raw.platform,raw.mode,raw.day ?? null,
            raw.offset_days ?? null,raw.version,raw.status]);
        await client.query(`INSERT INTO iron_gate.finance_outbox
          (id,property_id,source_kind,source_id,destination)
          VALUES ($1,$2,'payout_rule',$3,'sheet')`,
          [randomUUID(),propertyId,randomUUID()]);
        return { receipt_status:'accepted',request_key:requestKey,
          platform:raw.platform,version:raw.version,cash_effect_cents:0 };
      });
  }
  async payoutRules(principal, propertyId) {
    this.#authorize(principal,propertyId,'finance:read');
    return this.#transaction(propertyId,false,async client => {
      await this.#context(client,principal,propertyId,false);
      const result = await client.query(`SELECT platform,mode,day,offset_days,version,status
        FROM iron_gate.finance_payout_rule WHERE property_id=$1 ORDER BY platform`,[propertyId]);
      return { payout_rules:result.rows,cash_effect_cents:0 };
    });
  }
  async evidenceAssertion(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','event_id','evidence_level','evidence_ref',
      'processor_transaction_ref','settlement_batch_ref','bank_on']);
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
        await client.query(`INSERT INTO iron_gate.finance_outbox
          (id,property_id,source_kind,source_id,destination)
          VALUES ($1,$2,'evidence_assertion',$3,'sheet')`,[randomUUID(),propertyId,id]);
        return { receipt_status:'accepted',request_key:requestKey,assertion_id:id,
          event_id:raw.event_id,cash_effect_cents:0 };
      });
  }
  async settlement(principal, propertyId, raw, requestKey) {
    const keys = new Set(['request_key','settlement_batch_ref','processor_transaction_ref',
      'gross_cents','refund_cents','fee_cents','net_cents','bank_on','evidence_ref','links']);
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
        await client.query(`INSERT INTO iron_gate.finance_outbox
          (id,property_id,source_kind,source_id,destination)
          VALUES ($1,$2,'settlement',$3,'sheet')`,[randomUUID(),propertyId,id]);
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
        cash_effect_cents:0 };
    });
  }
  async ledger(principal, propertyId, query = {}) {
    this.#authorize(principal, propertyId, 'finance:read');
    const limit = Number(query.limit ?? 50);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_INPUT');
    const from = day(query.from), to = day(query.to);
    if (from && to && to < from) fail('INVALID_DATE');
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
      await this.#context(client, principal, propertyId, false);
      const rows = await client.query(`SELECT e.id,e.document_id,e.revision_version,
        e.event_kind,e.amount_cents,e.cash_effect_cents,e.effective_on,e.cash_on,
        e.service_on,e.category_code,e.receipt_purpose,
        COALESCE((SELECT a.evidence_level FROM iron_gate.finance_evidence_assertion a
          WHERE a.property_id=e.property_id AND a.event_id=e.id
          ORDER BY CASE a.evidence_level WHEN 'bank_reconciled' THEN 3
            WHEN 'processor_confirmed' THEN 2 ELSE 1 END DESC LIMIT 1),
          e.evidence_level) AS evidence_level,e.reverses_event_id,
        e.related_receipt_event_id,d.source_system,d.source_record_id
        FROM iron_gate.finance_event e JOIN iron_gate.finance_document d
          ON d.property_id=e.property_id AND d.id=e.document_id
        WHERE e.property_id=$1 AND ($2::date IS NULL OR e.effective_on >= $2::date)
          AND ($3::date IS NULL OR e.effective_on <= $3::date)
          AND ($4::date IS NULL OR (e.effective_on,e.id) > ($4::date,$5::uuid))
        ORDER BY e.effective_on,e.id LIMIT $6`,
        [propertyId,from,to,cursorDay,cursorId,limit+1]);
      const page = rows.rows.slice(0,limit).map(row => ({ ...row,
        effective_on: pgDay(row.effective_on), cash_on: pgDay(row.cash_on),
        service_on: pgDay(row.service_on) }));
      const last = page.at(-1);
      return { events: page, next_cursor: rows.rows.length > limit && last ?
        base64(JSON.stringify([last.effective_on,last.id])) : null,
        as_of_event_id: last?.id ?? null };
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
      const legacyIds = (booking.paymentEvents ?? []).map(e => e.id);
      const mapped = legacyIds.length ? await client.query(`SELECT existing_payment_event_id
        FROM iron_gate.finance_payment_ownership WHERE property_id=$1 AND booking_id=$2
          AND existing_payment_event_id=ANY($3::uuid[])`, [propertyId,bookingId,legacyIds]) :
        { rows: [] };
      const legacyUnmapped = mapped.rows.length !== legacyIds.length;
      const remaining = booking.source === 'os' && Number.isSafeInteger(booking.totalCents) &&
        !legacyUnmapped && summary.ota_guest_observed_cents === 0 &&
        summary.ota_payout_cents === 0 ?
        Math.max(0,booking.totalCents-summary.room_received_cents+
          summary.room_refunded_cents) : null;
      return { booking_id: bookingId, booking_version: booking.version,
        room_total_cents: booking.totalCents, currency: booking.currency,
        summary, remaining_due_cents: remaining,
        review_required: legacyUnmapped || remaining === null,
        events: events.rows.map(row => ({ ...row, effective_on: pgDay(row.effective_on),
          cash_on: pgDay(row.cash_on) })), as_of_event_id: events.rows.at(-1)?.id ?? null };
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
        as_of_event_id: page.at(-1)?.id ?? null };
    });
  }
  async accounts(principal, propertyId) {
    this.#authorize(principal, propertyId, 'finance:read');
    return this.#transaction(propertyId, false, async client => {
      await this.#context(client, principal, propertyId, false);
      const result = await client.query(`SELECT code,display_name,kind,status,version
        FROM iron_gate.finance_account WHERE property_id=$1 ORDER BY code`, [propertyId]);
      return { accounts: result.rows };
    });
  }
  async command(principal, propertyId, raw, requestKey) {
    const command = normalize(raw, requestKey);
    const action = command.action === 'void' || command.action === 'amend' ? 'finance:correct' :
      command.event_kind === 'property_refund' ? 'finance:refund' :
      ['expense_paid', 'processor_fee_paid'].includes(command.event_kind) ?
        'finance:record_expense' : 'finance:record_receipt';
    this.#authorize(principal, propertyId, action);
    const requestHash = hash(command);
    return this.#transaction(propertyId, true, async client => {
      const { state, source } = await this.#context(client, principal, propertyId, true);
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
      const bookings = this.#bookings(state, command);
      if (bookings.length) this.#verifyToken(raw.preview_token, principal, propertyId, command, bookings);
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
        const priorKind = await client.query(`SELECT event_kind FROM iron_gate.finance_event
          WHERE property_id=$1 AND document_id=$2 AND revision_version=$3 AND event_kind<>'reversal'`,
          [propertyId, documentId, version - 1]);
        if (priorKind.rows.length !== 1 ||
          (command.action === 'amend' && command.event_kind !== priorKind.rows[0].event_kind))
          fail('VERSION_CONFLICT', 409);
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
          WHERE property_id=$1 AND code=$2 AND status='active'`,
          [propertyId, command.payment_account_ref]);
        if (!account.rows.length) fail('INVALID_ACCOUNT', 422);
      }
      if (command.action !== 'void' && command.category_code) {
        const category = await client.query(`SELECT 1 FROM iron_gate.finance_category
          WHERE property_id=$1 AND kind='expense' AND code=$2 AND status='active'`,
          [propertyId, command.category_code]);
        if (!category.rows.length) fail('INVALID_CATEGORY', 422);
      }
      if (command.action !== 'void' && command.event_kind === 'property_refund') {
        const original = await client.query(`SELECT e.id,e.amount_cents,d.current_version,
          d.status,d.source_system
          FROM iron_gate.finance_document d JOIN iron_gate.finance_event e
          ON e.property_id=d.property_id AND e.document_id=d.id AND
             e.revision_version=d.current_version
          WHERE d.property_id=$1 AND d.id=$2 AND e.id=$3 AND
            e.event_kind='property_receipt'`, [propertyId,
            command.related_receipt_document_id, command.related_receipt_event_id]);
        if (!original.rows.length || original.rows[0].status !== 'active') fail('REFUND_LIMIT', 422);
        // Legacy Card/native receipts still have a booking JSON read path.
        // A generic refund must wait for its reviewed compatibility projection.
        if (['sweetfun_card','iron_gate_native'].includes(original.rows[0].source_system))
          fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
        const originalAllocations = await client.query(`SELECT booking_id,amount_cents,allocation_kind
          FROM iron_gate.finance_allocation WHERE property_id=$1 AND event_id=$2`,
          [propertyId, command.related_receipt_event_id]);
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
      }
      if (command.action !== 'void' && command.event_kind === 'property_receipt' &&
        ['room','deposit'].includes(command.receipt_purpose)) {
        for (const allocation of command.booking_allocations) {
          const booking = state.bookings.find(b => b.id === allocation.booking_id);
          if (!Number.isSafeInteger(booking.totalCents) || booking.totalCents <= 0 ||
            booking.source !== 'os') fail('SOURCE_MAPPING_REVIEW_REQUIRED',409);
          // Until old payments have been mapped exactly, their ownership is ambiguous.
          if (booking.paymentEvents?.length || booking.cardChargeResults?.some(r => r.status === 'Done'))
            fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
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
          if (command.action === 'create') {
            const suspected = await client.query(`SELECT 1 FROM iron_gate.finance_allocation a
              JOIN iron_gate.finance_event e ON e.property_id=a.property_id AND e.id=a.event_id
              JOIN iron_gate.finance_document d ON d.property_id=e.property_id AND d.id=e.document_id
              WHERE a.property_id=$1 AND a.booking_id=$2 AND a.amount_cents=$3
                AND e.event_kind='property_receipt' AND
                  e.effective_on BETWEEN ($4::date - 3) AND ($4::date + 3)
                AND e.revision_version=d.current_version AND d.status='active'
              LIMIT 1`, [propertyId, allocation.booking_id, allocation.amount_cents,
                command.effective_on]);
            if (suspected.rows.length) fail('SOURCE_MAPPING_REVIEW_REQUIRED', 409);
          }
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
        (property_id,document_id,version,action,request_hash,source_version,actor_ref,reason_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [propertyId, documentId, version,
        command.action, requestHash, command.source_version, principal.subjectId, command.reason_code]);
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
             payment_method_code,payment_account_ref,advanced_by_ref,safe_description,
             evidence_level,evidence_ref,reverses_event_id,actor_ref)
            VALUES ($1,$2,$3,$4,'reversal',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
            [reversalId, propertyId, documentId, version, event.amount_cents,
              -Number(event.cash_effect_cents), event.effective_on, event.cash_on,
              event.service_on, event.category_code, event.category_kind, event.receipt_purpose,
              event.payment_method_code, event.payment_account_ref, event.advanced_by_ref,
              event.safe_description, event.evidence_level, event.evidence_ref, event.id,
              principal.subjectId]);
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
           payment_method_code,payment_account_ref,advanced_by_ref,safe_description,
           evidence_level,evidence_ref,related_receipt_document_id,related_receipt_event_id,actor_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          [eventId, propertyId, documentId, version, kind, command.amount_cents, cashEffect,
            command.effective_on, command.cash_on, command.service_on, command.category_code,
            ['expense_paid','processor_fee_paid'].includes(kind) ? 'expense' : null,
            command.receipt_purpose, command.payment_method_code, command.payment_account_ref,
            command.advanced_by_ref, command.safe_description, command.evidence_level,
            command.evidence_ref, command.related_receipt_document_id,
            command.related_receipt_event_id, principal.subjectId]);
        for (const a of command.booking_allocations) await client.query(`INSERT INTO iron_gate.finance_allocation
          (property_id,event_id,booking_id,amount_cents,allocation_kind) VALUES ($1,$2,$3,$4,$5)`,
          [propertyId, eventId, a.booking_id, a.amount_cents, a.allocation_kind]);
        for (const a of command.expense_attributions) await client.query(`INSERT INTO iron_gate.finance_expense_attribution
          (property_id,event_id,month,amount_cents,allocation_policy) VALUES ($1,$2,$3,$4,$5)`,
          [propertyId, eventId, a.month, a.amount_cents, a.allocation_policy]);
        eventIds.push(eventId);
        if (command.action === 'create' && command.provider_transaction_ref)
          await client.query(`INSERT INTO iron_gate.finance_payment_ownership
          (id,property_id,provider_code,source_account_ref,provider_transaction_ref,
           booking_id,canonical_document_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [randomUUID(),propertyId,command.payment_method_code,source.source_account_ref,
            command.provider_transaction_ref,command.booking_allocations[0].booking_id,documentId]);
      }
      for (const eventId of eventIds) await client.query(`INSERT INTO iron_gate.finance_outbox
        (id,property_id,source_kind,source_id,destination) VALUES ($1,$2,'event',$3,'sheet')`,
        [randomUUID(), propertyId, eventId]);
      const receipt = { receipt_status: 'accepted', document_id: documentId,
        document_version: version, event_ids: eventIds, request_key: requestKey,
        as_of_event_id: eventIds.at(-1) ?? null };
      await client.query(`INSERT INTO iron_gate.finance_request_receipt
        (property_id,source_instance_id,request_key,request_hash,status,response_json)
        VALUES ($1,$2,$3,$4,'accepted',$5::jsonb)`,
        [propertyId, principal.financeSourceInstanceId, requestKey, requestHash, JSON.stringify(receipt)]);
      return receipt;
    });
  }
}
