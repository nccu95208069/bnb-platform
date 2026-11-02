// Guest payment and OTA payout can describe the same money. Count each track in
// cents, then use the greater confirmed total rather than adding both tracks.
type AmountRecord={amount:number;payment_type:string;payment_method:string};
export function roomPaymentCents(financeReceived:number,receipts:AmountRecord[]){
  const room=receipts.filter(r=>r.payment_type!=='other');
  const all=room.reduce((sum,r)=>sum+Math.round(r.amount*100),0);
  const direct=Math.round(financeReceived*100)+room.filter(r=>r.payment_method!=='ota').reduce((sum,r)=>sum+Math.round(r.amount*100),0);
  return Math.max(all,direct);
}
