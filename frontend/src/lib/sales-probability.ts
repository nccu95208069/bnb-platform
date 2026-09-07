import type { SalesProbability } from './availability';

// Presentation groups collapse the engine's five tiers without changing pricing.
export function probabilityBand(p: SalesProbability | null | undefined) {
  if (!p || !Number.isFinite(p.value) || p.value < 0 || p.value > 1) return 'unknown';
  return p.value < 0.4 ? 'low' : p.value < 0.6 ? 'medium' : 'high';
}
export const probabilityStyles = {
  low: 'border-blue-300 bg-blue-100 text-blue-950',
  medium: 'border-emerald-300 bg-emerald-100 text-emerald-950',
  high: 'border-red-300 bg-red-100 text-red-950',
  unknown: 'border-slate-200 bg-slate-50 text-slate-700',
};
export function probabilityText(p: SalesProbability | null | undefined) {
  if (probabilityBand(p) === 'unknown') return '機率未提供';
  // One decimal prevents values just below a threshold from rounding into another band.
  return `售出 ${Math.floor(p!.value * 1000) / 10}%`;
}
