export type GuestRemark = { kind: 'extra_bed' | 'extra_guest' | 'travel_card' | 'travel_subsidy' | 'receipt' | 'crib'; label: string; source: string };
// Deterministic extraction only. A mention is never proof of fulfilment or eligibility.
export function parseGuestRemarks(raw: string): GuestRemark[] {
 const result: GuestRemark[] = [];
 const pattern = /國旅補助?|國旅卡?|加床|[+＋]\s*\d+\s*人|(?:需要|需|要)?收據|(?:需要|需|要)?嬰兒床/gu;
 for (const match of raw.matchAll(pattern)) {
  const source=match[0], prefix=raw.slice(Math.max(0,match.index-6),match.index);
  // Retain negative/changed requests in the original text, not as positive tags.
  if (/^\s*(?:取消|不用|不需|不要)/.test(raw.slice(match.index+source.length))) continue;
  if (/(?:不|不用|不需|不需要|無需|不要|取消|免)\s*$/.test(prefix)) continue;
  const kind:GuestRemark['kind']=source.startsWith('國旅補')?'travel_subsidy':source.startsWith('國旅')?'travel_card':source==='加床'?'extra_bed':/[+＋]/.test(source)?'extra_guest':source.includes('收據')?'receipt':'crib';
  const label=({travel_subsidy:'國旅補',travel_card:'國旅卡',extra_bed:'加床',extra_guest:source.replace(/[＋]/g,'+').replace(/\s/g,''),receipt:'收據',crib:'嬰兒床'})[kind];
  if(!result.some(item=>item.kind===kind&&item.label===label))result.push({kind,label,source});
 }
 return result;
}
