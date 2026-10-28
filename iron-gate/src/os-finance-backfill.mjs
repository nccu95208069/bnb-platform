import { createHash } from 'node:crypto';

// Pure planning and reconciliation plus an injected read-only capture adapter.
// No production connection or import submission is built into this module.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const HEX = /^[0-9a-f]{64}$/;
const SOURCE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const METHODS = new Set(['cash', 'bank_transfer', 'credit_card', 'other']);
const SYSTEMS = new Set(['os_manual', 'os_legacy_payment']);
const CATEGORY_LABELS = {
  income:{lodging:'住宿收入',breakfast:'早餐費',overtime:'超時／延退費',
    extra_guest:'加人／加床',partner:'合作廠商收入',other:'其他收入'},
  expense:{laundry:'備品送洗',water:'水費',electricity:'電費',gas:'瓦斯費',
    utilities:'水電瓦斯（舊分類）',cable:'第四台',internet:'網路費',
    cleaning:'打掃清潔',supplies:'備品採購',repairs:'修繕維護',rent:'租金',
    small_items:'小物雜支',other:'其他花費'},
};
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const int = value => Number.isSafeInteger(value);
const validDay = value => typeof value === 'string' && DAY.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTimestamp = value => typeof value === 'string' &&
  /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const sorted = value => Array.isArray(value) ? value.map(sorted) : object(value) ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const cashSign = kind => kind === 'expense_paid' || kind === 'property_refund' ? -1 : 1;
const dayGap = (left,right) => Math.abs(Date.parse(`${left}T00:00:00Z`)-
  Date.parse(`${right}T00:00:00Z`))/86400000;
const keyFor = (system, id) => `${system}:${id}`;
const actorRef = (property, actor) => typeof actor === 'string' && actor.length > 0 &&
  actor.length <= 256 && !/[\u0000-\u001f\u007f]/.test(actor) ?
  `os_actor:${hash(`${property}:${actor}`)}` : null;
const importKey = (property, system, kind, id, version) =>
  `osimp:${hash(`${property}:${system}:${kind}:${id}:${version}`).slice(0,48)}`;
const originHash = (sourceKey, sourceRecordId, version, sourceValue) =>
  hash(canonical({sourceKey,sourceRecordId,version,sourceValue}));
const title = value => typeof value === 'string' && value.length <= 100 &&
  !/[\u0000-\u001f\u007f@]|(?:\d[ -]?){13,19}|\+?\d{9,}/.test(value);

function issue(code, sourceKey, sourceRecordId = null) {
  return { code, source_key: sourceKey, source_record_id: sourceRecordId };
}
function operationSourceVersion(state, operation, sourceKey) {
  const index = state.operations.indexOf(operation);
  if (state.version !== state.operations.length || index < 0 ||
    !SOURCE_ID.test(operation?.id ?? '') || !HEX.test(operation?.hash ?? '') ||
    !validTimestamp(operation?.at) ||
    operation.event && (operation.event.version_before !== index ||
      operation.event.version_after !== index + 1 ||
      operation.event.id !== operation.id || operation.event.at !== operation.at))
    throw Error('SOURCE_VERSION_UNVERIFIED');
  return `redis:${sourceKey.slice(-4)}:${index + 1}`;
}
function receiptSourceVersion(ledger, receipt, index) {
  const audit = receipt.audit;
  if (audit != null) {
    if (!object(audit) || !int(audit.version_after) || audit.version_after < 1 ||
      audit.version_after > ledger.version ||
      audit.version_before !== audit.version_after - 1 ||
      audit.target_type !== 'receipt' || audit.target_id !== receipt.id ||
      audit.request_id !== receipt.request_id || audit.actor_id !== receipt.actor ||
      audit.at !== receipt.created_at ||
      audit.action !== (receipt.status_only ? 'calendar_payment_confirmed' :
        'calendar_payment_recorded') || audit.after &&
        (audit.after.id !== receipt.id || audit.after.amount !== receipt.amount ||
          Boolean(audit.after.status_only) !== Boolean(receipt.status_only)))
      throw Error('SOURCE_VERSION_UNVERIFIED');
    return `redis:ledger:${audit.version_after}`;
  }
  // A legacy ledger with no subsequent Sheet-sync rewrite has one append per
  // receipt. Once its version exceeds the receipt count, the append revision
  // cannot be reconstructed without each receipt's audit evidence.
  if (ledger.version !== ledger.receipts.length) throw Error('SOURCE_VERSION_UNVERIFIED');
  return `redis:ledger:${index + 1}`;
}
function parseValue(raw) {
  if (typeof raw !== 'string') throw Error('NON_STRING_REDIS_VALUE');
  let value;
  try { value = JSON.parse(raw); }
  catch { throw Error('INVALID_REDIS_JSON'); }
  if (!object(value)) throw Error('INVALID_REDIS_JSON');
  return value;
}
function taipeiDay(timestamp) {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))) throw Error('INVALID_RECEIPT_TIME');
  const date = new Date(timestamp);
  return new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',
    year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
function monthRows(entry) {
  const spread = entry.expense_spread ?? [{month:entry.date.slice(0, 7),
    amount_cents:entry.amount_cents}];
  if (!Array.isArray(spread) || !spread.length || spread.length > 120 ||
    spread.some(row => !object(row) || !MONTH.test(row.month) || !int(row.amount_cents) ||
      row.amount_cents <= 0) ||
    spread.reduce((sum, row) => sum + row.amount_cents, 0) !== entry.amount_cents)
    throw Error('INVALID_EXPENSE_SPREAD');
  const begin = Number(spread[0].month.slice(0, 4)) * 12 + Number(spread[0].month.slice(5)) - 1;
  if (spread.some((row, i) => {
    const ordinal = Number(row.month.slice(0, 4)) * 12 + Number(row.month.slice(5)) - 1;
    return ordinal !== begin + i;
  })) throw Error('INVALID_EXPENSE_SPREAD');
  return spread.map(row => ({month:`${row.month}-01`,amount_cents:row.amount_cents,
    allocation_policy:'os_source_exact'}));
}
function validEntry(entry, property) {
  if (!object(entry) || !SOURCE_ID.test(entry.id ?? '') || entry.property_id !== property ||
    entry.source !== 'manual' || !['income','expense'].includes(entry.kind) ||
    !['active','void'].includes(entry.status) || !validDay(entry.date) ||
    !int(entry.amount_cents) || entry.amount_cents <= 0 ||
    entry.amount_cents > 1_000_000_000 || typeof entry.category !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(entry.category) ||
    typeof entry.method !== 'string' || !validDay(entry.created_at?.slice(0,10)) ||
    !Array.isArray(entry.history ?? [])) throw Error('INVALID_MANUAL_ENTRY');
}
function linkFor(links, system, orderKey, property, sourceInstanceId) {
  if (!UUID.test(sourceInstanceId ?? '')) throw Error('SOURCE_INSTANCE_UNVERIFIED');
  const found = links.filter(link => link.source_system === system &&
    link.source_instance_id === sourceInstanceId && link.source_order_key === orderKey);
  if (found.length !== 1) throw Error(found.length ? 'AMBIGUOUS_SOURCE_LINK' : 'SOURCE_LINK_MISSING');
  const link = found[0];
  if (link.property_id !== property || link.reviewed !== true ||
    !UUID.test(link.booking_id ?? '') || !int(link.booking_version) ||
    link.booking_version < 1 || !HEX.test(link.snapshot_hash ?? ''))
    throw Error('SOURCE_LINK_UNVERIFIED');
  if (link.booking_status === 'cancelled') throw Error('CANCELLED_BOOKING_REVIEW');
  return link;
}
function allocationsFor(entry, options, property) {
  if (entry.kind !== 'income' || entry.category !== 'lodging') {
    if (entry.allocations?.length) throw Error('UNEXPECTED_ORDER_ALLOCATION');
    return [];
  }
  if (!Array.isArray(entry.allocations) || !entry.allocations.length ||
    entry.allocations.length > 100) throw Error('LODGING_ORDER_REQUIRED');
  const seen = new Set();
  const allocations = entry.allocations.map(row => {
    if (!object(row) || !SOURCE_ID.test(row.order_id ?? '') ||
      !int(row.amount_cents) || row.amount_cents <= 0 || seen.has(row.order_id))
      throw Error('INVALID_ORDER_ALLOCATION');
    seen.add(row.order_id);
    const link = linkFor(options.links ?? [], 'os_manual', row.order_id, property,
      options.source_instances?.os_manual);
    return {booking_id:link.booking_id,expected_booking_version:link.booking_version,
      source_order_key:row.order_id,source_snapshot_hash:link.snapshot_hash,
      allocation_kind:entry.stage === 'deposit' ? 'deposit' : 'room',
      amount_cents:row.amount_cents};
  });
  if (allocations.reduce((sum, row) => sum + row.amount_cents, 0) !== entry.amount_cents ||
    new Set(allocations.map(row => row.booking_id)).size !== allocations.length)
    throw Error('INVALID_ORDER_ALLOCATION');
  return allocations;
}
function accountFor(account, system, options, property, method) {
  if (account == null) return null;
  if (!UUID.test(options.source_instances?.[system] ?? ''))
    throw Error('SOURCE_INSTANCE_UNVERIFIED');
  if (!object(account) || !SOURCE_ID.test(account.id ?? '') ||
    account.method !== method || !title(account.name) ||
    !/^\d{4,5}$/.test(account.last_digits ?? '')) throw Error('INVALID_SOURCE_ACCOUNT');
  const mappings = (options.account_map ?? []).filter(row => row.source_system === system &&
    row.source_instance_id === options.source_instances[system] &&
    row.source_account_id === account.id);
  if (mappings.length !== 1 || mappings[0].property_id !== property ||
    mappings[0].reviewed !== true) throw Error('ACCOUNT_MAPPING_REQUIRED');
  const target = (options.catalog?.accounts ?? []).find(row => row.code === mappings[0].account_code &&
    row.status === 'active');
  if (!target || target.kind !== (method === 'credit_card' ? 'card' : 'bank') ||
    target.last_digits !== account.last_digits) throw Error('ACCOUNT_MAPPING_MISMATCH');
  return target.code;
}
function categoryFor(entry, options) {
  const kind = entry.kind === 'expense' ? 'expense' : 'income';
  const found = (options.catalog?.categories ?? []).find(row => row.kind === kind &&
    row.code === entry.category && row.status === 'active');
  if (!found || (entry.category_name && found.label !== entry.category_name))
    throw Error('CATEGORY_NOT_PROVISIONED');
  return found.code;
}
function advancedBy(entry) {
  if (entry.advanced_by == null) return {};
  const advance = entry.advanced_by;
  if (entry.kind !== 'expense' || !object(advance) ||
    !['self','account','other'].includes(advance.type) || !title(advance.name))
    throw Error('ADVANCE_MAPPING_REQUIRED');
  const ref = advance.type === 'other' ? `other:${hash(advance.name)}` : advance.account_id;
  if (!SOURCE_ID.test(ref ?? '')) throw Error('ADVANCE_MAPPING_REQUIRED');
  return {advanced_by_ref:ref,advanced_by_kind:advance.type,
    advanced_by_label:advance.name};
}
function baseMoney(entry, options, property, action, version, originVersion,
  sourceKey, fingerprint) {
  validEntry(entry, property);
  if (entry.method === 'ota') throw Error('OTA_PAYER_UNVERIFIED');
  if (!METHODS.has(entry.method)) throw Error('INVALID_PAYMENT_METHOD');
  if (!validDay(entry.date) || entry.kind === 'income' && entry.category === 'lodging' &&
    !['deposit','balance','full','other',''].includes(entry.stage ?? ''))
    throw Error('INVALID_MANUAL_ENTRY');
  const expense = entry.kind === 'expense';
  const eventKind = expense ? 'expense_paid' : 'property_receipt';
  const allocation = allocationsFor(entry, options, property);
  const result = {request_key:`osimp:${hash(`${property}:os_manual:${entry.id}:${version}`).slice(0,48)}`,
    source_record_id:entry.id,source_version:originVersion,action,
    ...(action === 'amend' ? {expected_version:version-1} : {}),
    event_kind:eventKind,amount_cents:entry.amount_cents,currency:'TWD',
    effective_on:entry.date,cash_on:entry.date,service_on:entry.date,
    category_code:categoryFor(entry, options),
    ...(expense ? {} : {receipt_purpose:entry.category === 'lodging' ?
      entry.stage === 'deposit' ? 'deposit' : 'room' : 'other'}),
    payment_method_code:entry.method,evidence_level:'operator_attested',
    evidence_ref:`os:${fingerprint.slice(0,48)}`,
    booking_allocations:allocation,
    expense_attributions:expense ? monthRows(entry) : [],
    ...advancedBy(entry)};
  if (entry.payment_account) result.payment_account_ref = accountFor(entry.payment_account,
    'os_manual', options, property, entry.method);
  return result;
}
function record(system, sourceKey, id, version, kind, status, fingerprint, command = null,
  reasons = [], expected = null, sourceActorRef = null) {
  return {source_system:system,source_key:sourceKey,source_record_id:id,
    source_version:String(version),kind,status,source_hash:fingerprint,
    ...(command ? {command} : {}),reasons,expected,
    source_actor_ref:sourceActorRef ?? null,
    actor_evidence:sourceActorRef ? 'source_id_hash' : 'unknown'};
}
function dueDate(start, day) {
  let year = Number(start.slice(0,4)), month = Number(start.slice(5,7));
  for (let i = 0; i < 2; i++) {
    const last = new Date(Date.UTC(year,month,0)).getUTCDate();
    const candidate = `${year}-${String(month).padStart(2,'0')}-${String(Math.min(day,last)).padStart(2,'0')}`;
    if (candidate >= start) return candidate;
    month++;
    if (month === 13) { month = 1; year++; }
  }
  throw Error('INVALID_RECURRING_RULE');
}
function manualRecords(sourceKey, raw, state, property, options, issues) {
  const out = [];
  if (!int(state.version) || state.version < 0 || !Array.isArray(state.entries) ||
    !Array.isArray(state.operations) || !Array.isArray(state.recurring ?? []) ||
    !Array.isArray(state.payment_accounts ?? []) || !Array.isArray(state.payout_rules ?? [])) {
    issues.push(issue('INVALID_FINANCE_STATE', sourceKey));
    return out;
  }
  const year = Number(sourceKey.slice(-4));
  if (state.version !== state.operations.length) issues.push(issue('OPERATION_COUNT_MISMATCH', sourceKey));
  const ids = new Set();
  for (const entry of state.entries) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    if (id && ids.has(id)) { issues.push(issue('DUPLICATE_MANUAL_ID', sourceKey,id)); continue; }
    if (id) ids.add(id);
    const fingerprint = hash(raw);
    try {
      validEntry(entry,property);
      const history = entry.history ?? [];
      if (history.length > 200 || entry.kind === 'income' && history.length)
        throw Error('INVALID_VERSION_CHAIN');
      const snapshots = history.map(step => {
        if (!object(step) || !object(step.before) ||
          typeof step.at !== 'string' || !Number.isFinite(Date.parse(step.at)))
          throw Error('INVALID_VERSION_CHAIN');
        const prior = step.before;
        if (prior.id !== entry.id || prior.property_id !== property ||
          prior.kind !== entry.kind || prior.status !== 'active' ||
          prior.source !== 'manual') throw Error('INVALID_VERSION_CHAIN');
        validEntry(prior,property);
        return prior;
      });
      const current = {...entry,status:'active'};
      delete current.history;
      delete current.void_at;
      delete current.void_reason;
      delete current.void_actor;
      snapshots.push(current);
      if (Number(snapshots[0].date.slice(0,4)) !== year) throw Error('SOURCE_YEAR_MISMATCH');
      const operations = state.operations.filter(op => op?.entry_id === entry.id);
      const wanted = snapshots.length + (entry.status === 'void' ? 1 : 0);
      if (operations.length !== wanted || operations.some((op,i) =>
        !SOURCE_ID.test(op.id ?? '') || !HEX.test(op.hash ?? '') ||
        typeof op.at !== 'string' || !Number.isFinite(Date.parse(op.at)) ||
        op.event && (op.event.target_type !== 'entry' ||
          op.event.target_id !== entry.id ||
          op.event.action !== (i===0 ? entry.kind==='expense' ? 'expense_created' :
            'income_created' : i===wanted-1 && entry.status==='void' ?
            entry.kind==='expense'?'expense_voided':'income_voided' :
            entry.kind==='expense'?'expense_updated':'income_updated')) ||
        i > 0 && op.at < operations[i-1].at)) throw Error('OPERATION_CHAIN_MISMATCH');
      if (entry.recurrence_id != null || entry.occurrence != null) {
        if (!SOURCE_ID.test(entry.recurrence_id ?? '') || !validDay(entry.occurrence) ||
          entry.kind !== 'expense' || entry.date < entry.occurrence)
          throw Error('INVALID_RECURRING_OCCURRENCE');
        throw Error('RECURRENCE_LINK_UNREPRESENTABLE');
      }
      for (let i = 0; i < snapshots.length; i++) {
        const action = i ? 'amend' : 'create';
        const originVersion = operationSourceVersion(state,operations[i],sourceKey);
        const command = baseMoney(snapshots[i],options,property,action,i+1,
          originVersion,sourceKey,fingerprint);
        command.origin_request_hash=originHash(sourceKey,entry.id,originVersion,snapshots[i]);
        command.source_actor_ref=actorRef(property,operations[i].actor);
        command.source_recorded_at=operations[i].at;
        if (!command.source_actor_ref) throw Error('SOURCE_ACTOR_UNVERIFIED');
        const item = record('os_manual',sourceKey,entry.id,i+1,'money','ready',fingerprint,
          command,[],{event_kind:command.event_kind,amount_cents:command.amount_cents,
            cash_on:command.cash_on,booking_allocations:command.booking_allocations,
            expense_attributions:command.expense_attributions},
          actorRef(property,operations[i]?.actor));
        item.source_operation_id=operations[i].id;
        item.source_operation_hash=operations[i].hash;
        item.origin_source_version=originVersion;
        item.source_recorded_at=operations[i].at;
        out.push(item);
      }
      if (entry.status === 'void') {
        if (!entry.void_at || !Number.isFinite(Date.parse(entry.void_at)))
          throw Error('INVALID_VOID');
        const version = snapshots.length + 1;
        const originVersion = operationSourceVersion(state,operations[version-1],sourceKey);
        const last = out.at(-1).command;
        const item = record('os_manual',sourceKey,entry.id,version,'money','ready',fingerprint,
          {request_key:`osimp:${hash(`${property}:os_manual:${entry.id}:${version}`).slice(0,48)}`,
            source_record_id:entry.id,source_version:originVersion,expected_version:version-1,
            action:'void',reason_code:'os_operator_void',
            origin_request_hash:originHash(sourceKey,entry.id,originVersion,entry),
            source_actor_ref:actorRef(property,operations[version-1].actor),
            source_recorded_at:operations[version-1].at,
            booking_guards:last.booking_allocations.map(a => ({booking_id:a.booking_id,
              expected_booking_version:a.expected_booking_version}))},
          [],{event_kind:'reversal',amount_cents:0,cash_on:null},
          actorRef(property,operations[version-1]?.actor));
        item.source_operation_id=operations[version-1].id;
        item.source_operation_hash=operations[version-1].hash;
        item.origin_source_version=originVersion;
        item.source_recorded_at=operations[version-1].at;
        if (!item.source_actor_ref) throw Error('SOURCE_ACTOR_UNVERIFIED');
        out.push(item);
      }
    } catch (error) {
      for (let i = out.length - 1; i >= 0; i--) if (out[i].source_record_id === id &&
        out[i].source_key === sourceKey) out.splice(i,1);
      issues.push(issue(error.message || 'INVALID_MANUAL_ENTRY',sourceKey,id));
      const item = record('os_manual',sourceKey,id,'?', 'money','review',fingerprint,
        null,[error.message || 'INVALID_MANUAL_ENTRY']);
      if (entry?.recurrence_id || entry?.occurrence)
        item.recurrence = {recurrence_id:entry.recurrence_id ?? null,
          occurrence:entry.occurrence ?? null};
      out.push(item);
    }
  }
  for (const rule of state.recurring ?? []) {
    const id = rule?.id;
    const reasons = [];
    if (!SOURCE_ID.test(id ?? '') || rule.year !== year || !validDay(rule.start) ||
      rule.end != null && !validDay(rule.end) || !int(rule.amount_cents) ||
      rule.amount_cents <= 0 || !int(rule.day) || rule.day < 1 || rule.day > 31 ||
      !METHODS.has(rule.method)) reasons.push('INVALID_RECURRING_RULE');
    else {
      try { categoryFor({...rule,kind:'expense'},options); }
      catch (error) { reasons.push(error.message); }
    }
    if (!reasons.length && rule.stopped_at && (!validDay(rule.stopped_at.slice(0,10)) ||
      rule.stopped_at.slice(0,10) < rule.start)) reasons.push('INVALID_RECURRING_STOP');
    const ruleOps = state.operations.filter(op => op?.entry_id === id);
    if (!reasons.length && ruleOps.length !== (rule.stopped_at ? 2 : 1))
      reasons.push('OPERATION_CHAIN_MISMATCH');
    if (!reasons.length && ruleOps.some((op,i)=>op.event &&
      (op.event.target_type!=='recurring_expense' || op.event.target_id!==id ||
        op.event.action!==(i?'recurring_stopped':'recurring_created'))))
      reasons.push('OPERATION_CHAIN_MISMATCH');
    let originVersions = [];
    if (!reasons.length) {
      try { originVersions = ruleOps.map(op => operationSourceVersion(state,op,sourceKey)); }
      catch (error) { reasons.push(error.message); }
    }
    if (!reasons.length && ruleOps.some(op => !actorRef(property,op.actor) ||
      !validTimestamp(op.at))) reasons.push('SOURCE_ACTOR_UNVERIFIED');
    if (reasons.length) {
      out.push(record('os_manual',sourceKey,id,'?', 'recurring_rule','review',hash(raw),
        null,[...new Set(reasons)]));
      continue;
    }
    const first = {...rule};
    delete first.stopped_at;
    delete first.stopped_by;
    const firstDue = dueDate(rule.start,rule.day);
    if (rule.end && firstDue > rule.end) {
      out.push(record('os_manual',sourceKey,id,'?', 'recurring_rule','review',hash(raw),
        null,['INVALID_RECURRING_WINDOW']));
      continue;
    }
    for (const version of rule?.stopped_at ? [1,2] : [1]) {
      const sourceValue = version === 1 ? first : rule;
      const originVersion = originVersions[version-1];
      const end = version === 2 ? rule.stopped_at.slice(0,10) : rule.end ?? null;
      const next = version === 2 ? null : firstDue;
      const command = {request_key:importKey(property,'os_manual',
        'recurring_rule',id,version),origin_request_hash:originHash(sourceKey,id,
        originVersion,sourceValue),origin_source_version:originVersion,
        source_actor_ref:actorRef(property,ruleOps[version-1].actor),
        source_recorded_at:ruleOps[version-1].at,
        source_record_id:id,version,cadence:'monthly',
        start_on:rule.start,end_on:end,next_due_on:next,
        status:version===2?'ended':'active',category_code:rule.category,
        amount_cents:rule.amount_cents,safe_description:title(rule.description) ?
          rule.description : '',payment_method_code:rule.method,due_day:rule.day};
      const item = record('os_manual',sourceKey,id,version,'recurring_rule',
        'noncash',hash(raw),command,[],
        {amount_cents:rule.amount_cents,category_code:rule.category,
          start_on:rule.start,end_on:end,next_due_on:next,due_day:rule.day,
          payment_method_code:rule.method,status:version===2?'ended':'active',
          cash_effect_cents:0},actorRef(property,ruleOps[version-1]?.actor));
      item.origin_source_version=originVersion;
      item.source_operation_id=ruleOps[version-1].id;
      item.source_operation_hash=ruleOps[version-1].hash;
      out.push(item);
    }
  }
  for (const account of state.payment_accounts ?? []) {
    const reasons = [];
    if (!SOURCE_ID.test(account?.id ?? '') || account.id.length > 64 ||
      account.property_id !== property ||
      !['credit_card','bank_transfer'].includes(account.method) ||
      !title(account.name) || !(account.method==='credit_card' ? /^\d{4}$/ :
        /^\d{5}$/).test(account.last_digits ?? '')) reasons.push('INVALID_SOURCE_ACCOUNT');
    const accountOps = state.operations.filter(op => op?.entry_id === account?.id);
    if (!reasons.length && accountOps.length !== 1) reasons.push('OPERATION_CHAIN_MISMATCH');
    if (!reasons.length && (accountOps[0].actor!==account.actor_id ||
      accountOps[0].event && (accountOps[0].event.target_type!=='payment_account' ||
        accountOps[0].event.target_id!==account.id ||
        accountOps[0].event.action!=='payment_account_created')))
      reasons.push('OPERATION_CHAIN_MISMATCH');
    let originVersion = null;
    if (!reasons.length) {
      try { originVersion=operationSourceVersion(state,accountOps[0],sourceKey); }
      catch (error) { reasons.push(error.message); }
    }
    if (!reasons.length && (!actorRef(property,account.actor_id) ||
      !validTimestamp(account.created_at))) reasons.push('SOURCE_ACTOR_UNVERIFIED');
    const existing = (options.catalog?.accounts ?? []).filter(row=>
      row.code===account?.id);
    const kind = account?.method==='credit_card'?'card':'bank';
    if (!reasons.length && (existing.length>1 || existing.length===1 &&
      (existing[0].status!=='active' || existing[0].kind!==kind ||
        existing[0].last_digits!==account.last_digits ||
        existing[0].display_name!==account.name)))
      reasons.push('ACCOUNT_CATALOG_CONFLICT');
    const command = reasons.length || existing.length ? null : {request_key:importKey(property,'os_manual',
      'payment_account',account.id,1),origin_request_hash:originHash(sourceKey,
      account.id,originVersion,account),origin_source_version:originVersion,
      source_actor_ref:actorRef(property,account.actor_id),
      source_recorded_at:account.created_at,code:account.id,display_name:account.name,
      kind,last_digits:account.last_digits};
    const item = record('os_manual',sourceKey,account?.id,1,'payment_account',
      reasons.length?'review':existing.length?'existing':'noncash',hash(raw),command,reasons,
      reasons.length?null:{code:account.id,display_name:account.name,kind,
        method:account.method,last_digits:account.last_digits,
        cash_effect_cents:0},actorRef(property,account.actor_id ?? accountOps[0]?.actor));
    item.origin_source_version=originVersion;
    item.source_operation_id=accountOps[0]?.id ?? null;
    item.source_operation_hash=accountOps[0]?.hash ?? null;
    out.push(item);
  }
  for (const rule of state.payout_rules ?? []) {
    const valid = ['ctrip','owljourney'].includes(rule?.platform) &&
      ['manual','monthly'].includes(rule.mode) && int(rule.day) &&
      rule.day >= 1 && rule.day <= 31 && int(rule.offset) &&
      rule.offset >= 1 && rule.offset <= 3;
    const ruleOps = state.operations.filter(op => op?.event?.target_type === 'payout_rule' &&
      op.event.target_id === rule?.platform);
    const reasons = valid ? [] : ['INVALID_PAYOUT_RULE'];
    if (valid && ruleOps.length !== 1) reasons.push('PAYOUT_VERSION_EVIDENCE_REQUIRED');
    if (!reasons.length && ruleOps[0].event &&
      (ruleOps[0].event.target_type!=='payout_rule' ||
        ruleOps[0].event.target_id!==rule.platform ||
        ruleOps[0].event.action!=='payout_rule_updated'))
      reasons.push('OPERATION_CHAIN_MISMATCH');
    let originVersion = null;
    if (!reasons.length) {
      try { originVersion=operationSourceVersion(state,ruleOps[0],sourceKey); }
      catch (error) { reasons.push(error.message); }
    }
    if (!reasons.length && (!actorRef(property,ruleOps[0].actor) ||
      !validTimestamp(ruleOps[0].at))) reasons.push('SOURCE_ACTOR_UNVERIFIED');
    const command = reasons.length ? null : {request_key:importKey(property,'os_manual',
      'payout_rule',rule.platform,1),origin_request_hash:originHash(sourceKey,
      rule.platform,originVersion,rule),origin_source_version:originVersion,
      source_actor_ref:actorRef(property,ruleOps[0].actor),
      source_recorded_at:ruleOps[0].at,
      platform:rule.platform,version:1,
      mode:rule.mode==='monthly'?'fixed_day':'manual',
      ...(rule.mode==='monthly'?{day:rule.day,offset_months:rule.offset}:{}),status:'active'};
    const item = record('os_manual',sourceKey,rule?.platform,1,'payout_rule',
      reasons.length?'review':'noncash',hash(raw),command,reasons,
      valid?{platform:rule.platform,mode:rule.mode,day:rule.day,offset:rule.offset,
        cash_effect_cents:0}:null,actorRef(property,ruleOps[0]?.actor));
    item.origin_source_version=originVersion;
    item.source_operation_id=ruleOps[0]?.id ?? null;
    item.source_operation_hash=ruleOps[0]?.hash ?? null;
    out.push(item);
  }
  return out;
}
function paymentRecords(sourceKey, raw, ledger, property, options, orderRefs, issues) {
  if (!int(ledger.version) || ledger.version < 0 || !Array.isArray(ledger.receipts) ||
    ledger.version < ledger.receipts.length) {
    issues.push(issue('INVALID_PAYMENT_LEDGER',sourceKey)); return [];
  }
  const matches = orderRefs.filter(order => order.key === sourceKey);
  const paymentIds = new Set(matches.map(order => order.payment_order_id));
  if (paymentIds.size !== 1 || matches.some(order => order.status === 'cancelled'))
    issues.push(issue(matches.length?'AMBIGUOUS_PAYMENT_ORDER':'PAYMENT_ORDER_UNRESOLVED',sourceKey));
  const order = paymentIds.size === 1 && matches.every(order =>
    order.status === 'current') ? matches[0] : null;
  const out = [];
  const seenReceipts = new Set();
  const duplicateReceiptIds = new Set();
  for (const [receiptIndex,receipt] of ledger.receipts.entries()) {
    if (!object(receipt)) {
      issues.push(issue('INVALID_PAYMENT_RECEIPT',sourceKey,`index:${receiptIndex}`));
      out.push(record('os_legacy_payment',sourceKey,`index:${receiptIndex}`,'?',
        'money','review',hash(raw),null,['INVALID_PAYMENT_RECEIPT']));
      continue;
    }
    const id = receipt?.id;
    const reasons = [];
    let originVersion = null;
    try { originVersion=receiptSourceVersion(ledger,receipt,receiptIndex); }
    catch (error) { reasons.push(error.message); }
    if (!SOURCE_ID.test(receipt?.request_id ?? '') ||
      !HEX.test(receipt?.request_hash ?? '')) reasons.push('SOURCE_REQUEST_INVALID');
    if (seenReceipts.has(id)) {
      reasons.push('DUPLICATE_RECEIPT_ID'); duplicateReceiptIds.add(id);
    }
    seenReceipts.add(id);
    if (!SOURCE_ID.test(id ?? '') || !int(receipt?.amount) &&
      (typeof receipt?.amount !== 'number' || !Number.isFinite(receipt.amount)))
      reasons.push('INVALID_PAYMENT_RECEIPT');
    let cents = null, cashDay = null, link = null;
    try {
      cents = Math.round(receipt.amount * 100);
      if (!Number.isSafeInteger(cents) || Math.abs(receipt.amount*100-cents)>0.00001 ||
        cents < 0 || cents > 1_000_000_000) throw Error('INVALID_PAYMENT_AMOUNT');
      cashDay = taipeiDay(receipt.received_at);
      if (!validTimestamp(receipt.created_at) || !actorRef(property,receipt.actor) ||
        typeof receipt.settles_room !== 'boolean' ||
        receipt.sheet_sync != null && !['pending','verified'].includes(
          receipt.sheet_sync?.state)) throw Error('INVALID_PAYMENT_RECEIPT');
      if (!order) throw Error('PAYMENT_ORDER_UNRESOLVED');
      if (order.status === 'cancelled') throw Error('CANCELLED_BOOKING_REVIEW');
      link = linkFor(options.links ?? [],'os_legacy_payment',order.payment_order_id,
        property,options.source_instances?.os_legacy_payment);
      if (receipt.sheet_sync?.state === 'pending' ||
        receipt.sheet_sync?.failure?.requires_review) throw Error('SHEET_SYNC_PENDING');
      if (receipt.payment_method === 'ota') throw Error('OTA_PAYER_UNVERIFIED');
      if (!METHODS.has(receipt.payment_method)) throw Error('INVALID_PAYMENT_METHOD');
      if (!['deposit','balance','full','other'].includes(receipt.payment_type))
        throw Error('INVALID_PAYMENT_TYPE');
      if (receipt.status_only && (cents !== 0 || receipt.payment_type !== 'full' ||
        receipt.payment_method !== 'other' || receipt.settles_room !== true ||
        receipt.sheet_sync?.state !== 'verified')) throw Error('INVALID_STATUS_ONLY');
      if (!receipt.status_only && cents <= 0) throw Error('INVALID_PAYMENT_AMOUNT');
    } catch (error) { reasons.push(error.message || 'INVALID_PAYMENT_RECEIPT'); }
    const fingerprint = hash(raw);
    const status = reasons.length ? 'review' : receipt.status_only ? 'noncash' : 'ready';
    const expected = status === 'review' ? null : receipt.status_only ?
      {status_code:'room_confirmed',settles_room:true,booking_id:link.booking_id,
        cash_effect_cents:0} :
      {event_kind:'property_receipt',amount_cents:cents,cash_on:cashDay,
        booking_allocations:[{booking_id:link.booking_id,amount_cents:cents,
          allocation_kind:receipt.payment_type==='deposit'?'deposit':
            receipt.payment_type==='other'?'extra':'room'}],cash_effect_cents:cents};
    let command = null;
    const confirmedCommand = status !== 'review' && receipt.settles_room === true ? {
      request_key:importKey(property,'os_legacy_payment','operational_status',id,1),
      origin_request_hash:originHash(sourceKey,id,originVersion,receipt),
      origin_source_version:originVersion,
      source_actor_ref:actorRef(property,receipt.actor),
      source_recorded_at:receipt.created_at,
      source_record_id:id,version:1,status_code:'room_confirmed',
      settles_room:true,booking_id:link.booking_id,
      expected_booking_version:link.booking_version,
      source_order_key:order.payment_order_id,
      source_snapshot_hash:link.snapshot_hash} : null;
    if (status === 'noncash') command = confirmedCommand;
    if (status === 'noncash' && (!actorRef(property,receipt.actor) ||
      !validTimestamp(receipt.created_at))) {
      reasons.push('SOURCE_ACTOR_UNVERIFIED'); command = null;
    }
    if (status === 'ready') {
      const purpose = receipt.payment_type === 'deposit' ? 'deposit' :
        receipt.payment_type === 'other' ? 'extra' : 'room';
      command = {request_key:`osimp:${hash(`${property}:os_legacy_payment:${id}:1`).slice(0,48)}`,
        source_record_id:id,source_version:originVersion,action:'create',
        origin_request_hash:originHash(sourceKey,id,originVersion,receipt),
        source_actor_ref:actorRef(property,receipt.actor),
        source_recorded_at:receipt.created_at,
        event_kind:'property_receipt',amount_cents:cents,currency:'TWD',
        effective_on:cashDay,cash_on:cashDay,service_on:cashDay,
        category_code:purpose==='extra'?'other':'lodging',receipt_purpose:purpose,
        payment_method_code:receipt.payment_method,evidence_level:'operator_attested',
        evidence_ref:`os:${fingerprint.slice(0,48)}`,
        booking_allocations:[{booking_id:link.booking_id,
          expected_booking_version:link.booking_version,
          source_order_key:order.payment_order_id,
          source_snapshot_hash:link.snapshot_hash,
          allocation_kind:purpose,amount_cents:cents}],expense_attributions:[]};
      if (receipt.payment_account) {
        try { command.payment_account_ref = accountFor(receipt.payment_account,
          'os_legacy_payment',options,property,receipt.payment_method); }
        catch (error) { reasons.push(error.message); command = null; }
      }
    }
    const item = record('os_legacy_payment',sourceKey,id,1,
      receipt.status_only?'operational_status':'money',reasons.length?'review':status,
      fingerprint,command,reasons,reasons.length?null:expected,
      actorRef(property,receipt?.actor));
    item.source_request_id=SOURCE_ID.test(receipt?.request_id ?? '') ? receipt.request_id : null;
    item.source_request_hash=HEX.test(receipt?.request_hash ?? '') ? receipt.request_hash : null;
    item.origin_source_version=originVersion;
    out.push(item);
    if (!receipt?.status_only && receipt?.settles_room === true) {
      const statusReasons = [...reasons];
      if (!actorRef(property,receipt.actor) || !validTimestamp(receipt.created_at))
        statusReasons.push('SOURCE_ACTOR_UNVERIFIED');
      const statusItem = record('os_legacy_payment',sourceKey,id,1,
        'operational_status',statusReasons.length?'review':'noncash',fingerprint,
        statusReasons.length?null:confirmedCommand,statusReasons,
        statusReasons.length?null:{status_code:'room_confirmed',settles_room:true,
          booking_id:link.booking_id,cash_effect_cents:0},
        actorRef(property,receipt.actor));
      statusItem.source_request_id=item.source_request_id;
      statusItem.source_request_hash=item.source_request_hash;
      statusItem.origin_source_version=originVersion;
      out.push(statusItem);
    }
  }
  for (const row of out.filter(row => duplicateReceiptIds.has(row.source_record_id))) {
    row.status='review'; row.command=null; row.expected=null;
    if (!row.reasons.includes('DUPLICATE_RECEIPT_ID')) row.reasons.push('DUPLICATE_RECEIPT_ID');
  }
  for (const id of duplicateReceiptIds) issues.push(issue('DUPLICATE_RECEIPT_ID',sourceKey,id));
  return out;
}

function categoryRecords(snapshot, property, catalog, issues) {
  const categories = new Map();
  for (const row of [...snapshot.records].sort((a,b) =>
    String(a?.key).localeCompare(String(b?.key)))) {
    if (!new RegExp(`^sweetfun-os:finance:v1:${property}:20\\d{2}$`).test(row?.key ?? ''))
      continue;
    let state;
    try { state = parseValue(row.value); }
    catch { continue; } // The original state parser already reports this key.
    const sources = [];
    for (const entry of Array.isArray(state.entries)?state.entries:[]) {
      if (!object(entry)) continue;
      const current = {...entry,status:'active'};
      delete current.history;
      delete current.void_at;
      delete current.void_reason;
      delete current.void_actor;
      const snapshots = [...(Array.isArray(entry.history) ? entry.history.map(h=>h?.before) : []),
        current];
      const ops = Array.isArray(state.operations) ?
        state.operations.filter(op=>op?.entry_id===entry.id) : [];
      snapshots.forEach((source,index) => sources.push({source,operation:ops[index]}));
    }
    for (const rule of Array.isArray(state.recurring)?state.recurring:[]) {
      const op = Array.isArray(state.operations) ?
        state.operations.find(value=>value?.entry_id===rule?.id) : null;
      sources.push({source:{...rule,kind:'expense'},operation:op});
    }
    for (const {source,operation} of sources) {
      if (!object(source) || !['expense','income'].includes(source.kind) ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(source.category ?? '')) continue;
      const kind = source.kind;
      const id = `${kind}:${source.category}`;
      const builtinLabel = CATEGORY_LABELS[kind][source.category] ?? null;
      const label = source.category_name ?? builtinLabel;
      const builtin = builtinLabel !== null;
      let originVersion = null;
      if (!builtin) {
        try { originVersion=operationSourceVersion(state,operation,row.key); }
        catch { /* A missing origin version is an explicit review blocker below. */ }
      }
      const candidate = {kind,code:source.category,label,
        source_key:row.key,source_hash:hash(row.value),builtin,
        conflict:builtin && source.category_name != null &&
          source.category_name !== builtinLabel,
        origin_source_version:originVersion,
        origin_record_hash:builtin ? null : originHash(row.key,id,originVersion,source),
        source_operation_id:builtin ? null : operation?.id ?? null,
        source_operation_hash:builtin ? null : operation?.hash ?? null,
        source_actor_ref:builtin ? null : actorRef(property,operation?.actor),
        source_recorded_at:builtin ? null : operation?.at ?? null};
      const prior = categories.get(id);
      if (prior && prior.label !== label) {
        prior.conflict = true;
        issues.push(issue('CATEGORY_LABEL_CONFLICT',row.key,id));
      } else if (!prior || candidate.source_recorded_at &&
        (!prior.source_recorded_at || candidate.source_recorded_at < prior.source_recorded_at))
        categories.set(id,{...candidate,conflict:prior?.conflict ?? false});
    }
  }
  return [...categories.entries()].map(([id,source]) => {
    const existing = (catalog?.categories ?? []).filter(value =>
      value.kind === source.kind && value.code === source.code);
    const reasons = source.conflict ? ['CATEGORY_LABEL_CONFLICT'] :
      !title(source.label) || !source.label?.trim() ? ['CATEGORY_LABEL_UNKNOWN'] :
      existing.length > 1 || existing.length === 1 &&
        (existing[0].label !== source.label || existing[0].status !== 'active') ?
        ['CATEGORY_CATALOG_CONFLICT'] :
      source.builtin && !existing.length ? ['BUILTIN_CATEGORY_CONFIGURATION_REQUIRED'] :
      !existing.length && (!source.origin_source_version || !source.source_actor_ref ||
        !validTimestamp(source.source_recorded_at)) ? ['SOURCE_ACTOR_UNVERIFIED'] : [];
    const command = reasons.length || existing.length ? null : {
      request_key:importKey(property,'os_manual','category',id,1),
      origin_request_hash:source.origin_record_hash,
      origin_source_version:source.origin_source_version,
      source_actor_ref:source.source_actor_ref,
      source_recorded_at:source.source_recorded_at,
      kind:source.kind,code:source.code,label:source.label};
    const item = record('os_manual',source.source_key,id,1,'category',
      reasons.length?'review':existing.length?'existing':'noncash',
      source.source_hash,command,reasons,reasons.length?null:{
        kind:source.kind,code:source.code,label:source.label,cash_effect_cents:0},
      source.source_actor_ref);
    item.origin_source_version=source.origin_source_version;
    item.source_operation_id=source.source_operation_id;
    item.source_operation_hash=source.source_operation_hash;
    return item;
  });
}

/** Read-only double capture through an injected Redis SCAN/MGET adapter. */
export async function captureOsFinanceSnapshot({property_id,scan,mget,
  payment_orders=[],captured_at=new Date().toISOString()}) {
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(property_id ?? '') ||
    typeof scan !== 'function' || typeof mget !== 'function' ||
    !Array.isArray(payment_orders)) throw Error('INVALID_CAPTURE_INPUT');
  const patterns = [`sweetfun-os:finance:v1:${property_id}:*`,
    `sweetfun-os:payments:v1:${property_id}:*`];
  async function pass() {
    const keys = new Set();
    for (const pattern of patterns) {
      let cursor = '0', pages = 0;
      do {
        const page = await scan(cursor,pattern);
        const next = Array.isArray(page) ? page[0] : page?.cursor;
        const found = Array.isArray(page) ? page[1] : page?.keys;
        if (!Array.isArray(found) || !/^[0-9]+$/.test(String(next)) || ++pages > 1000)
          throw Error('SOURCE_SCAN_INCOMPLETE');
        for (const key of found) {
          if (typeof key !== 'string' || !key.startsWith(pattern.slice(0,-1)))
            throw Error('CROSS_PROPERTY_SOURCE_KEY');
          if (/^sweetfun-os:payments:v1:[^:]+:[a-f0-9]{64}:mission:/.test(key))
            continue;
          if (!new RegExp(`^sweetfun-os:finance:v1:${property_id}:20\\d{2}$`).test(key) &&
            !new RegExp(`^sweetfun-os:payments:v1:${property_id}:[a-f0-9]{64}$`).test(key))
            throw Error('UNRECOGNIZED_SOURCE_KEY');
          keys.add(key);
        }
        cursor = String(next);
      } while (cursor !== '0');
    }
    const list = [...keys].sort(), records = [];
    for (let at=0; at<list.length; at+=100) {
      const batch = list.slice(at,at+100), values = await mget(batch);
      if (!Array.isArray(values) || values.length !== batch.length ||
        values.some(value => typeof value !== 'string')) throw Error('SOURCE_CHANGED_DURING_CAPTURE');
      records.push(...batch.map((key,i) => ({key,value:values[i]})));
    }
    return records;
  }
  const first = await pass(), second = await pass();
  if (canonical(first) !== canonical(second)) throw Error('SOURCE_CHANGED_DURING_CAPTURE');
  return {schema_version:1,property_id,captured_at,scan_complete:true,
    payment_orders,records:second};
}

/** Build import candidates from exact Redis values and reviewed source links. */
export function planOsFinanceBackfill(bundle) {
  if (!object(bundle) || !object(bundle.snapshot) ||
    !/^[a-z][a-z0-9_-]{0,63}$/.test(bundle.snapshot.property_id ?? '') ||
    !Array.isArray(bundle.snapshot.records)) throw Error('INVALID_SNAPSHOT_ENVELOPE');
  const snapshot = bundle.snapshot, property = snapshot.property_id;
  const issues = [], records = [], seenKeys = new Set();
  if (snapshot.schema_version !== 1 || snapshot.scan_complete !== true ||
    !Number.isFinite(Date.parse(snapshot.captured_at ?? '')))
    issues.push(issue('SNAPSHOT_COVERAGE_UNVERIFIED','snapshot'));
  const orderRefs = [];
  for (const order of snapshot.payment_orders ?? []) {
    if (!object(order) || order.property_id !== property ||
      !SOURCE_ID.test(order.order_id ?? '') ||
      order.payment_order_id != null && !SOURCE_ID.test(order.payment_order_id) ||
      !['current','cancelled'].includes(order.status)) {
      issues.push(issue('INVALID_PAYMENT_ORDER_REF','snapshot')); continue;
    }
    const paymentId = order.payment_order_id ?? order.order_id;
    orderRefs.push({...order,payment_order_id:paymentId,
      key:`sweetfun-os:payments:v1:${property}:${hash(JSON.stringify(paymentId))}`});
  }
  for (const row of snapshot.records) {
    if (!object(row) || typeof row.key !== 'string' || typeof row.value !== 'string') {
      issues.push(issue('INVALID_SNAPSHOT_RECORD','snapshot')); continue;
    }
    if (seenKeys.has(row.key)) { issues.push(issue('DUPLICATE_REDIS_KEY',row.key)); continue; }
    seenKeys.add(row.key);
    const manual = new RegExp(`^sweetfun-os:finance:v1:${property}:20\\d{2}$`).test(row.key);
    const payment = new RegExp(`^sweetfun-os:payments:v1:${property}:[a-f0-9]{64}$`).test(row.key);
    if (!manual && !payment) {
      issues.push(issue('OUT_OF_SCOPE_REDIS_KEY',row.key)); continue;
    }
    try {
      const value = parseValue(row.value);
      records.push(...(manual ? manualRecords(row.key,row.value,value,property,bundle,issues) :
        paymentRecords(row.key,row.value,value,property,bundle,orderRefs,issues)));
    } catch (error) { issues.push(issue(error.message || 'INVALID_REDIS_JSON',row.key)); }
  }
  records.push(...categoryRecords(snapshot,property,bundle.catalog,issues));
  const identities = new Map();
  for (const row of records) {
    const id = keyFor(row.source_system,row.source_record_id);
    const old = identities.get(id);
    if (old && old !== row.source_key) {
      for (const candidate of records.filter(value =>
        keyFor(value.source_system,value.source_record_id) === id)) {
        candidate.status='review'; candidate.command=null;
        if (!candidate.reasons.includes('DUPLICATE_SOURCE_ID'))
          candidate.reasons.push('DUPLICATE_SOURCE_ID');
      }
      issues.push(issue('DUPLICATE_SOURCE_ID',row.source_key,row.source_record_id));
    } else identities.set(id,row.source_key);
  }
  const legacyIds = new Map();
  for (const row of records.filter(row => row.source_system === 'os_legacy_payment')) {
    const key = `${row.source_record_id}:${row.kind}`;
    const rows = legacyIds.get(key) ?? [];
    rows.push(row); legacyIds.set(key,rows);
  }
  for (const [id,rows] of legacyIds) if (rows.length > 1) {
    for (const row of rows) {
      row.status='review'; row.command=null;
      if (!row.reasons.includes('DUPLICATE_RECEIPT_ID')) row.reasons.push('DUPLICATE_RECEIPT_ID');
    }
    issues.push(issue('DUPLICATE_RECEIPT_ID',rows[0].source_key,id));
  }
  // Same booking, day and amount across sources is only a suspicion. It is
  // never promoted to an alias or accepted as a second payment automatically.
  const signatures = new Map();
  for (const row of records.filter(row => row.kind === 'money' && row.command?.action === 'create' &&
    row.command.event_kind === 'property_receipt')) {
    for (const allocation of row.command.booking_allocations) {
      const signature = `${allocation.booking_id}:${row.command.cash_on}:${allocation.amount_cents}`;
      const prior = signatures.get(signature);
      if (prior && prior !== row) {
        for (const candidate of records.filter(value => [prior,row].some(other =>
          other.source_system === value.source_system &&
          other.source_record_id === value.source_record_id))) {
          candidate.status='review'; candidate.command=null;
          if (!candidate.reasons.includes('SUSPECTED_CROSS_SOURCE_DUPLICATE'))
            candidate.reasons.push('SUSPECTED_CROSS_SOURCE_DUPLICATE');
        }
        issues.push(issue('SUSPECTED_CROSS_SOURCE_DUPLICATE',row.source_key,row.source_record_id));
      } else signatures.set(signature,row);
    }
  }
  const knownAliases = Array.isArray(bundle.known_aliases) ? bundle.known_aliases : [];
  const references = Array.isArray(bundle.reference_events) ? bundle.reference_events : [];
  for (const row of records.filter(row => row.kind === 'money' && row.command?.action === 'create')) {
    const aliased = knownAliases.some(alias => alias?.property_id === property &&
      alias.source_system === row.source_system &&
      alias.source_record_id === row.source_record_id);
    const suspected = row.command.event_kind === 'property_receipt' &&
      references.some(event => event?.property_id === property &&
        event.document_status === 'active' && event.event_kind === 'property_receipt' &&
        event.source_system !== row.source_system && validDay(event.cash_on) &&
        dayGap(event.cash_on,row.command.cash_on) <= 3 &&
        Array.isArray(event.booking_allocations) &&
        event.booking_allocations.some(actual => row.command.booking_allocations.some(expected =>
          expected.booking_id === actual.booking_id &&
          expected.amount_cents === Number(actual.amount_cents))));
    if (aliased || suspected) {
      const reason = aliased ? 'EXISTING_CANONICAL_ALIAS' : 'SUSPECTED_CROSS_SOURCE_DUPLICATE';
      for (const candidate of records.filter(value =>
        value.source_system === row.source_system &&
        value.source_record_id === row.source_record_id)) {
        candidate.status='review'; candidate.command=null;
        if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
      }
      issues.push(issue(reason,row.source_key,row.source_record_id));
    }
  }
  const sourceHash = hash(canonical(snapshot.records.map(row => [row.key,row.value]).sort((a,b) =>
    String(a[0]).localeCompare(String(b[0])))));
  const moneyGroups = new Map();
  for (const row of records.filter(row => row.kind === 'money')) {
    const id = keyFor(row.source_system,row.source_record_id);
    moneyGroups.set(id,[...(moneyGroups.get(id) ?? []),row]);
  }
  let sourceNetCash = 0;
  for (const rows of moneyGroups.values()) {
    if (rows.some(row => row.status !== 'ready')) continue;
    const last = [...rows].sort((a,b) => Number(a.source_version)-Number(b.source_version)).at(-1);
    if (last.command?.action !== 'void')
      sourceNetCash += cashSign(last.command.event_kind) * last.command.amount_cents;
  }
  return {schema_version:1,property_id:property,captured_at:snapshot.captured_at,
    snapshot_hash:sourceHash,coverage_complete:issues.length===0,
    source_instances:bundle.source_instances ?? {},records,issues,
    summary:{redis_keys:seenKeys.size,candidates:records.length,
      ready_money:records.filter(row => row.status==='ready').length,
      review:records.filter(row => row.status==='review').length,
      noncash:records.filter(row => row.status==='noncash').length,
      source_net_cash_cents:sourceNetCash,
      cross_source_reference_complete:bundle.reference_complete === true}};
}

/** Compare every expected OS revision with a pinned, complete Iron Gate readback. */
export function reconcileOsFinanceBackfill(plan, readback) {
  if (!object(plan) || !Array.isArray(plan.records)) throw Error('INVALID_PLAN');
  const differences = [];
  if (!object(readback) || readback.complete !== true ||
    !int(readback.as_of_change_seq) || readback.unsequenced_event_count !== 0 ||
    !Array.isArray(readback.events)) {
    return {status:'unverified',scope:'offline_snapshot',cutover_ready:false,
      snapshot_hash:plan.snapshot_hash,
      as_of_change_seq:null,differences:[{code:'LEDGER_READBACK_INCOMPLETE'}]};
  }
  const instances = plan.source_instances ?? {};
  if (new Set(readback.events.map(event => event?.id).filter(Boolean)).size !==
    readback.events.filter(event => event?.id).length ||
    readback.events.some(event => !UUID.test(event?.id ?? '')))
    differences.push({code:'EVENT_ID_MISSING_OR_DUPLICATE'});
  const expectedGroups = new Map();
  for (const row of plan.records.filter(row => row.kind === 'money' && row.status === 'ready')) {
    const instance = instances[row.source_system];
    if (!UUID.test(instance ?? '')) {
      differences.push({code:'SOURCE_INSTANCE_UNVERIFIED',source_system:row.source_system,
        source_record_id:row.source_record_id}); continue;
    }
    const key = `${instance}:${row.source_record_id}`;
    expectedGroups.set(key,[...(expectedGroups.get(key) ?? []),row]);
  }
  const actualGroups = new Map();
  for (const event of readback.events) {
    if (!SYSTEMS.has(event?.source_system)) continue;
    const instance = instances[event.source_system];
    if (event.source_instance_id !== instance) {
      differences.push({code:'CROSS_INSTANCE_EVENT',source_system:event.source_system,
        source_record_id:event.source_record_id}); continue;
    }
    const key = `${instance}:${event.source_record_id}`;
    actualGroups.set(key,[...(actualGroups.get(key) ?? []),event]);
  }
  for (const [key, rows] of expectedGroups) {
    const actual = actualGroups.get(key) ?? [];
    const revisions = [...rows].sort((a,b) =>
      Number(a.source_version)-Number(b.source_version));
    const want = [];
    let previous = null;
    for (const revision of revisions) {
      const command = revision.command;
      const version = Number(revision.source_version);
      if (previous) want.push({revision_version:version,event_kind:'reversal',
        source_version:command.source_version,revision_action:command.action,
        evidence_level:previous.evidence_level,
        evidence_ref:previous.evidence_ref,
        amount_cents:previous.amount_cents,
        cash_effect_cents:-cashSign(previous.event_kind)*previous.amount_cents,
        effective_on:previous.effective_on,cash_on:previous.cash_on,
        service_on:previous.service_on,category_code:previous.category_code,
        receipt_purpose:previous.receipt_purpose,payment_method_code:previous.payment_method_code,
        payment_account_ref:previous.payment_account_ref,
        advanced_by_ref:previous.advanced_by_ref,advanced_by_kind:previous.advanced_by_kind,
        advanced_by_label:previous.advanced_by_label,safe_description:previous.safe_description,
        source_actor_ref:command.source_actor_ref,
        source_recorded_at:command.source_recorded_at,
        booking_allocations:previous.booking_allocations.map(a => ({booking_id:a.booking_id,
          amount_cents:-a.amount_cents,allocation_kind:a.allocation_kind})),
        expense_attributions:previous.expense_attributions.map(a => ({month:a.month,
          amount_cents:-a.amount_cents,allocation_policy:a.allocation_policy}))});
      if (command.action !== 'void') {
        want.push({revision_version:version,event_kind:command.event_kind,
          source_version:command.source_version,revision_action:command.action,
          evidence_level:command.evidence_level,
          evidence_ref:command.evidence_ref,
          amount_cents:command.amount_cents,
          cash_effect_cents:cashSign(command.event_kind)*command.amount_cents,
          effective_on:command.effective_on,cash_on:command.cash_on,
          service_on:command.service_on,category_code:command.category_code,
          receipt_purpose:command.receipt_purpose,payment_method_code:command.payment_method_code,
          payment_account_ref:command.payment_account_ref,
          advanced_by_ref:command.advanced_by_ref,advanced_by_kind:command.advanced_by_kind,
          advanced_by_label:command.advanced_by_label,safe_description:command.safe_description,
          source_actor_ref:command.source_actor_ref,
          source_recorded_at:command.source_recorded_at,
          booking_allocations:command.booking_allocations.map(a => ({booking_id:a.booking_id,
            amount_cents:a.amount_cents,allocation_kind:a.allocation_kind})),
          expense_attributions:command.expense_attributions});
        previous = command;
      } else previous = null;
    }
    const normalize = event => canonical({revision_version:Number(event.revision_version),
      source_version:String(event.source_version),revision_action:event.revision_action,
      evidence_level:event.evidence_level,
      evidence_ref:event.evidence_ref ?? null,
      event_kind:event.event_kind,amount_cents:Number(event.amount_cents),
      cash_effect_cents:Number(event.cash_effect_cents),
      effective_on:event.effective_on ?? null,cash_on:event.cash_on ?? null,
      service_on:event.service_on ?? null,category_code:event.category_code ?? null,
      receipt_purpose:event.receipt_purpose ?? null,
      payment_method_code:event.payment_method_code ?? null,
      payment_account_ref:event.payment_account_ref ?? null,
      advanced_by_ref:event.advanced_by_ref ?? null,
      advanced_by_kind:event.advanced_by_kind ?? null,
      advanced_by_label:event.advanced_by_label ?? null,
      safe_description:event.safe_description ?? null,
      source_actor_ref:event.source_actor_ref ?? null,
      source_recorded_at:validTimestamp(event.source_recorded_at) ?
        new Date(event.source_recorded_at).toISOString() : null,
      booking_allocations:(event.booking_allocations ?? []).map(a => ({booking_id:a.booking_id,
        amount_cents:Number(a.amount_cents),allocation_kind:a.allocation_kind})).sort((a,b) =>
        canonical(a).localeCompare(canonical(b))),
      expense_attributions:(event.expense_attributions ?? []).map(a => ({month:a.month,
        amount_cents:Number(a.amount_cents),allocation_policy:a.allocation_policy})).sort((a,b) =>
        canonical(a).localeCompare(canonical(b)))});
    const expected = want.map(normalize).sort(), observed = actual.map(normalize).sort();
    if (canonical(expected) !== canonical(observed)) differences.push({code:'RECORD_EVENT_MISMATCH',
      source_system:rows[0].source_system,source_record_id:rows[0].source_record_id,
      expected_count:expected.length,actual_count:observed.length,
      expected_cash_cents:want.reduce((n,row) => n+row.cash_effect_cents,0),
      actual_cash_cents:actual.reduce((n,row) => n+Number(row.cash_effect_cents),0)});
    const last = revisions.at(-1);
    for (const revision of revisions) {
      const command = revision.command;
      const receipt = readback.receipts?.[command.request_key];
      if (!object(receipt) || receipt.receipt_status !== 'accepted' ||
        receipt.request_key !== command.request_key ||
        receipt.document_id !== actual[0]?.document_id ||
        Number(receipt.document_version) !== Number(revision.source_version) ||
        receipt.origin_request_hash !== command.origin_request_hash)
        differences.push({code:'IMPORT_RECEIPT_MISMATCH',source_system:rows[0].source_system,
          source_record_id:rows[0].source_record_id,
          source_version:command.source_version});
    }
    if (actual.length && (new Set(actual.map(event => event.document_id)).size !== 1 ||
      actual.some(event => !UUID.test(event.document_id ?? ''))))
      differences.push({code:'DOCUMENT_ID_MISMATCH',source_system:rows[0].source_system,
        source_record_id:rows[0].source_record_id});
    if (actual.length && actual.some(event => event.document_status !==
        (last.command.action === 'void'?'void':'active') ||
        Number(event.current_version) !== Number(last.source_version)))
      differences.push({code:'DOCUMENT_STATE_MISMATCH',source_system:rows[0].source_system,
        source_record_id:rows[0].source_record_id});
    actualGroups.delete(key);
  }
  for (const [key, actual] of actualGroups) differences.push({code:'UNEXPECTED_IMPORTED_RECORD',
    source_identity:key,actual_count:actual.length});
  for (const row of plan.records.filter(row => row.status === 'ready' &&
    row.command?.action === 'create' && row.command.event_kind === 'property_receipt')) {
    const similar = readback.events.some(event => event?.source_system !== row.source_system &&
      event.event_kind === 'property_receipt' && event.document_status === 'active' &&
      validDay(event.cash_on) && dayGap(event.cash_on,row.command.cash_on) <= 3 &&
      Array.isArray(event.booking_allocations) &&
      event.booking_allocations.some(actual => row.command.booking_allocations.some(expected =>
        expected.booking_id === actual.booking_id &&
        expected.amount_cents === Number(actual.amount_cents))));
    if (similar) differences.push({code:'SUSPECTED_CROSS_SOURCE_DUPLICATE',
      source_system:row.source_system,source_record_id:row.source_record_id});
  }
  const noncash = plan.records.filter(row => row.status === 'noncash');
  if (noncash.length) {
    const catalog = readback.catalog;
    if (!object(catalog) || catalog.complete !== true || catalog.next_cursor != null ||
      catalog.as_of_change_seq !== readback.as_of_change_seq ||
      !Array.isArray(catalog.entries)) differences.push({code:'NONCASH_READBACK_INCOMPLETE'});
    else {
      const actual = new Map();
      for (const row of catalog.entries) {
        const key = `${row.source_instance_id}:${row.record_kind}:${row.source_record_id}:${row.source_version}`;
        actual.set(key,[...(actual.get(key) ?? []),row]);
      }
      const latest = new Map();
      for (const row of noncash) {
        const instance = instances[row.source_system];
        if (!UUID.test(instance ?? '')) {
          differences.push({code:'SOURCE_INSTANCE_UNVERIFIED',source_system:row.source_system,
            source_record_id:row.source_record_id}); continue;
        }
        const recordKind = row.kind === 'payment_account' ? 'account' : row.kind;
        const identity = `${instance}:${recordKind}:${row.source_record_id}`;
        const key = `${identity}:${row.origin_source_version}`;
        const found = actual.get(key) ?? [];
        if (found.length !== 1) differences.push({code:'NONCASH_PROVENANCE_MISMATCH',
          source_system:row.source_system,source_record_id:row.source_record_id,
          source_version:row.source_version,actual_count:found.length});
        else {
          const item = found[0];
          const imported = Object.fromEntries(Object.entries(row.command ?? {}).filter(
            ([field]) => !['request_key','origin_request_hash','origin_source_version',
              'source_actor_ref','source_recorded_at'].includes(field)));
          if (item.source_snapshot_hash !== row.command?.origin_request_hash ||
            item.target_version !== Number(row.source_version) ||
            item.source_actor_ref !== row.command?.source_actor_ref ||
            Date.parse(item.source_recorded_at) !== Date.parse(row.command?.source_recorded_at) ||
            !object(item.imported_payload) ||
            Object.entries(imported).some(([field,value]) =>
              canonical(item.imported_payload[field] ?? null) !== canonical(value ?? null)))
            differences.push({code:'NONCASH_SOURCE_MISMATCH',source_system:row.source_system,
              source_record_id:row.source_record_id,source_version:row.source_version});
          const older = latest.get(identity);
          if (!older || Number(row.source_version)>Number(older.candidate.source_version))
            latest.set(identity,{candidate:row,actual:item});
        }
        actual.delete(key);
      }
      for (const [identity,rows] of actual) differences.push({
        code:'UNEXPECTED_NONCASH_IMPORT',source_identity:identity,actual_count:rows.length});
      for (const {candidate,actual:item} of latest.values()) {
        const target = item.target_current;
        const command = candidate.command;
        let fields;
        if (candidate.kind === 'operational_status')
          fields = ['source_record_id','version','status_code','settles_room','booking_id'];
        else if (candidate.kind === 'recurring_rule')
          fields = ['source_record_id','version','cadence','start_on','end_on','next_due_on',
            'status','category_code','amount_cents','safe_description',
            'payment_method_code','due_day'];
        else if (candidate.kind === 'payout_rule')
          fields = ['platform','version','mode','day','offset_months','status'];
        else if (candidate.kind === 'payment_account')
          fields = ['code','display_name','kind','last_digits'];
        else fields = ['kind','code','label'];
        if (!object(target) ||
          ['operational_status','recurring_rule','payout_rule'].includes(candidate.kind) &&
            Number(target.version) !== Number(candidate.source_version) ||
          fields.some(field =>
          canonical(target[field] ?? null) !== canonical(command[field] ?? null)) ||
          ['payment_account','category'].includes(candidate.kind) &&
            target.status !== 'active') differences.push({code:'NONCASH_TARGET_MISMATCH',
          source_system:candidate.source_system,source_record_id:candidate.source_record_id});
      }
    }
  }
  const existing = plan.records.filter(row => row.status === 'existing');
  if (existing.length) {
    const catalog = readback.existing_catalog;
    if (!object(catalog) || !Array.isArray(catalog.categories) ||
      !Array.isArray(catalog.accounts) || catalog.as_of_change_seq !== readback.as_of_change_seq)
      differences.push({code:'EXISTING_CATALOG_READBACK_REQUIRED',count:existing.length});
    else for (const row of existing) {
      const target = row.kind === 'category' ? catalog.categories.find(value =>
        value.kind === row.expected.kind && value.code === row.expected.code) :
        catalog.accounts.find(value => value.code === row.expected.code);
      if (!target || target.status !== 'active' || row.kind === 'category' &&
        target.label !== row.expected.label || row.kind === 'payment_account' &&
        (target.display_name !== row.expected.display_name ||
          target.kind !== row.expected.kind ||
          target.last_digits !== row.expected.last_digits))
        differences.push({code:'EXISTING_CATALOG_MISMATCH',
        source_record_id:row.source_record_id});
    }
  }
  if (plan.records.some(row => row.status === 'review') || plan.issues.length)
    differences.push({code:'SOURCE_REVIEW_REMAINS',count:plan.records.filter(row =>
      row.status === 'review').length + plan.issues.length});
  return {status:differences.length?'different':'matched',scope:'offline_snapshot',
    cutover_ready:false,snapshot_hash:plan.snapshot_hash,
    as_of_change_seq:readback.as_of_change_seq,differences,
    expected_money_records:expectedGroups.size,
    actual_money_records:new Set(readback.events.filter(event =>
      SYSTEMS.has(event.source_system)).map(event =>
      `${event.source_instance_id}:${event.source_record_id}`)).size};
}
