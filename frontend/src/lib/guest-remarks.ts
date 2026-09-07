export type GuestRemark = { kind: 'extra_bed' | 'extra_guest' | 'travel_card' | 'travel_subsidy' | 'receipt' | 'crib' | 'ig_contact' | 'influencer' | 'baby_bath' | 'bath_chair' | 'sterilizer'; label: string; source: string };
// Deterministic extraction only. A mention is never proof of fulfilment or eligibility.
export function parseGuestRemarks(raw: string): GuestRemark[] {
 const result: GuestRemark[] = [];
 const pattern = /IG網紅|(?<![A-Za-z])IG(?![A-Za-z])|(?:嬰兒)?澡盆|(?:浴室的?)?(?:塑膠|塑料)椅(?:子)?|消毒鍋|國旅補助?|國旅卡?|加床|[+＋]\s*\d+\s*人|(?:需要|需|要)?收據|(?:需要|需|要)?嬰兒床/giu;
 for (const match of raw.matchAll(pattern)) {
  const source=match[0], prefix=raw.slice(Math.max(0,match.index-6),match.index);
  // Retain negative/changed requests in the original text, not as positive tags.
  if (/^\s*(?:取消|不用|不需|不要)/.test(raw.slice(match.index+source.length))) continue;
  if (/(?:不|不用|不需|不需要|無需|不要|取消|免)\s*$/.test(prefix)) continue;
  const kind:GuestRemark['kind']=/IG網紅/i.test(source)?'influencer':/^IG$/i.test(source)?'ig_contact':source.includes('澡盆')?'baby_bath':source.includes('椅')?'bath_chair':source==='消毒鍋'?'sterilizer':source.startsWith('國旅補')?'travel_subsidy':source.startsWith('國旅')?'travel_card':source==='加床'?'extra_bed':/[+＋]/.test(source)?'extra_guest':source.includes('收據')?'receipt':'crib';
  const label=({ig_contact:'IG聯繫',influencer:'IG網紅邀請',baby_bath:'嬰兒澡盆',bath_chair:'浴室塑膠椅',sterilizer:'消毒鍋',travel_subsidy:'國旅補',travel_card:'國旅卡',extra_bed:'加床',extra_guest:source.replace(/[＋]/g,'+').replace(/\s/g,''),receipt:'收據',crib:'嬰兒床'})[kind];
  if(!result.some(item=>item.kind===kind&&item.label===label))result.push({kind,label,source});
 }
 return result;
}

// Only remove the explicit contact annotation when comparing adjacent names.
// Unknown annotations and genuinely different names must still require review.
export function comparableGuestName(raw:string):string {
 return raw.replace(/[（(]\s*IG\s*[）)]/gi,'').trim().replace(/\s+/g,' ').toLowerCase();
}
export function mergeGuestRemarks(remarks:GuestRemark[]):GuestRemark[]{
 return remarks.filter((r,i)=>remarks.findIndex(other=>other.kind===r.kind&&other.label===r.label)===i);
}
