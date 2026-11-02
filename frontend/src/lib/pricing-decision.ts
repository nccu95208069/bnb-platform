import type { Channel, SalesProbability } from './availability';

export const PUBLISH_STATUSES = ['shadow', 'proposed', 'skipped', 'verified', 'failed'] as const;
export type PricingDecision = {
  run_id: string;
  source_version: string;
  base_price: number | null;
  target_price: number;
  published_price: number | null;
  adjustment_pct: number | null;
  probability: SalesProbability | null;
  reason: string;
  model_version: string;
  policy_version: string;
  calculated_at: string;
  published_at: string | null;
  observed_at: string;
  publish_status: typeof PUBLISH_STATUSES[number];
};
export type PricingDecisions = Partial<Record<Channel, PricingDecision>>;
const keys = ['run_id','source_version','base_price','target_price','published_price','adjustment_pct','probability','reason','model_version','policy_version','calculated_at','published_at','observed_at','publish_status'];
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const price = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 10_000_000;
const time = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,19) === v.slice(0,19);
export function validatePricingDecisions(value: unknown, channels: readonly Channel[], snapshotAt: string): asserts value is PricingDecisions {
  if (!record(value) || !Object.keys(value).length) throw Error('INVALID_PRICING_DECISION');
  for (const [channel, raw] of Object.entries(value)) {
    if (!channels.includes(channel as Channel) || !record(raw) || Object.keys(raw).length !== keys.length || Object.keys(raw).some(k => !keys.includes(k))) throw Error('INVALID_PRICING_DECISION');
    const d = raw as PricingDecision;
    const baseValid = d.base_price === null
      ? d.adjustment_pct === null && ['shadow','skipped'].includes(d.publish_status)
      : typeof d.base_price === 'number' && Number.isFinite(d.base_price) && d.base_price > 0 && d.base_price <= 10_000_000 && typeof d.adjustment_pct === 'number' && Number.isFinite(d.adjustment_pct) && Math.abs(d.adjustment_pct - (d.target_price / d.base_price - 1) * 100) <= 0.011;
    if (!id(d.run_id) || !id(d.source_version) || !id(d.model_version) || !id(d.policy_version) || !baseValid || !price(d.target_price) || (d.published_price !== null && !price(d.published_price)) || typeof d.reason !== 'string' || !d.reason.trim() || d.reason.length > 500 || !PUBLISH_STATUSES.includes(d.publish_status) || !time(d.observed_at) || !time(d.calculated_at) || Date.parse(d.observed_at) > Date.parse(snapshotAt) || Date.parse(d.calculated_at) > Date.parse(d.observed_at)) throw Error('INVALID_PRICING_DECISION');
    if ((d.published_at === null) !== (d.published_price === null) || (d.published_at !== null && (!time(d.published_at) || Date.parse(d.published_at) < Date.parse(d.calculated_at) || Date.parse(d.published_at) > Date.parse(d.observed_at)))) throw Error('INVALID_PRICING_DECISION');
    if (d.publish_status === 'verified' && (d.published_price !== d.target_price || !d.published_at)) throw Error('INVALID_PRICING_DECISION');
    if (['shadow','proposed','skipped'].includes(d.publish_status) && d.published_price !== null) throw Error('INVALID_PRICING_DECISION');
    const p = d.probability;
    if (p !== null && (!record(p) || Object.keys(p).sort().join() !== 'asof,source_version,value' || !Number.isFinite(p.value) || p.value < 0 || p.value > 1 || !/^\d{4}-\d\d-\d\d$/.test(p.asof) || !Number.isFinite(Date.parse(p.asof)) || new Date(p.asof).toISOString().slice(0,10) !== p.asof || p.asof > new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(d.calculated_at)) || !/^[a-f0-9]{20}$/.test(p.source_version))) throw Error('INVALID_PRICING_DECISION');
  }
}
