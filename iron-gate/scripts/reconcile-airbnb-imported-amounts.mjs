import {readFileSync} from 'node:fs';
import {allocateWholeTwd} from './reconcile-airbnb-group-amount.mjs';
import {reconciledAmount,reconciledFinanceAmounts} from '../src/source-amount-reconciliation.ts';
const PROPERTIES={
 sweetfun:{id:'95ae9bd1-5e6d-4386-be5b-6af3c5668a16',source:'sweetfun-calendar-sheet',account:'1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc'},
 offland:{id:'8595525a-ecfd-5949-953f-99f004928597',source:'offland-calendar-sheet',account:'1jBJq1xWmM7xKpUxFjsLYQc7EbLAWmcMjQK0SBbaORuc'},
};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exact=(v,keys)=>v&&Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
const fail=()=>{throw Error('INVALID_AIRBNB_IMPORTED_AMOUNT_MANIFEST');};
export function validateImportedAmounts(m){
 try{
  if(!exact(m,'schema,requestKey,properties')||m.schema!==2||!UUID.test(m.requestKey)||
   !Array.isArray(m.properties)||!m.properties.length||m.properties.length>2)fail();
  const properties=new Set(),groupIds=new Set(),bookingIds=new Set();
  for(const p of m.properties){
   if(!exact(p,'sourceProperty,propertyId,expectedInventoryVersion,groups'))fail();
   const cfg=PROPERTIES[p.sourceProperty];
   if(!cfg||p.propertyId!==cfg.id||properties.has(p.propertyId)||!Number.isSafeInteger(p.expectedInventoryVersion)||
    p.expectedInventoryVersion<1||!Array.isArray(p.groups)||!p.groups.length||p.groups.length>100)fail();
   properties.add(p.propertyId);
   const corrected=[];
   for(const g of p.groups){
    if(!exact(g,'groupId,evidence,targets')||!UUID.test(g.groupId)||groupIds.has(g.groupId)||
     !Array.isArray(g.targets)||!g.targets.length||g.targets.length>256)fail();
    groupIds.add(g.groupId);
    const e=g.evidence;
    if(!exact(e,'orderId,status,checkIn,checkOut,grossCents,hostFeeCents,netCents,taxCents,guestFeeCents,guestPaidCents,verifiedAt,platformEvidenceSha256,mailEvidenceSha256')||
     !/^HM[A-Z0-9]{8}$/.test(e.orderId)||!['confirmed','cancelled'].includes(e.status)||
     !/^\d{4}-\d{2}-\d{2}$/.test(e.checkIn)||!/^\d{4}-\d{2}-\d{2}$/.test(e.checkOut)||
     !Number.isFinite(Date.parse(e.verifiedAt))||e.checkOut<=e.checkIn||
     !/^[a-f0-9]{64}$/.test(e.platformEvidenceSha256)||!/^[a-f0-9]{64}$/.test(e.mailEvidenceSha256)||
     e.grossCents-e.hostFeeCents!==e.netCents||
     e.status==='cancelled'&&(e.netCents!==0||g.targets.length!==1||e.checkOut>=e.verifiedAt.slice(0,10)))fail();
    const weights=g.targets.map(t=>t.booking.totalCents),gross=allocateWholeTwd(e.grossCents,weights),net=allocateWholeTwd(e.netCents,weights);
    const original=weights.reduce((a,b)=>a+b,0),refs=new Set();
    for(const [i,t] of g.targets.entries()){
     if(!exact(t,'booking,link,amount'))fail();
     const b=t.booking,l=t.link,a=t.amount,snapshot=p.sourceProperty==='sweetfun'?b.sweetfunSnapshot:b.offlandSnapshot;
     const row=snapshot?.rows?.[0],stay=b.stays?.[0];
     if(!b||!l||!UUID.test(b.id)||bookingIds.has(b.id)||b.propertyId!==p.propertyId||b.source!=='external'||b.status!=='confirmed'||
      b.version!==1||b.sourceAmountReconciliation||b.sourceCalendar||b.sourceIdentityEnrichment||b.osDirectOverride||b.lineOverridePending||
      b.channelSyncState!=='not_required'||b.channelOperationKey!=null||(b.paymentEvents?.length??0)!==0||(b.cardChargeResults?.length??0)!==0||
      snapshot?.rows?.length!==1||b.stays?.length!==1||stay.roomIds?.length!==1||row?.roomFeeCents!==b.totalCents||
      stay.checkIn<e.checkIn||stay.checkOut>e.checkOut||
      l.bookingId!==b.id||l.sourceSystem!==cfg.source||l.sourceAccount!==cfg.account||l.externalOrderId!==snapshot.groupKey||
      l.key!==JSON.stringify([cfg.source,cfg.account,l.externalOrderId])||!/^sheet-v1:[a-f0-9]{64}$/.test(l.sourceVersion)||
      l.lastAppliedBookingVersion!==b.version||l.diverged!==false||l.tombstoneNights?.length!==0||refs.has(l.externalOrderId)||
      a.schema!==2||a.sourceProperty!==p.sourceProperty||a.groupId!==g.groupId||a.groupSize!==g.targets.length||
      a.bookingVersion!==b.version+1||a.sourceOrderRef!==l.externalOrderId||a.externalOrderNo!==e.orderId||
      a.originalTotalCents!==b.totalCents||a.grossCents!==gross[i]||a.netCents!==net[i]||a.hostFeeCents!==gross[i]-net[i]||
      a.groupOriginalCents!==original||a.groupGrossCents!==e.grossCents||a.groupHostFeeCents!==e.hostFeeCents||
      a.groupNetCents!==e.netCents||a.groupTaxCents!==e.taxCents||a.groupGuestFeeCents!==e.guestFeeCents||a.groupGuestPaidCents!==e.guestPaidCents)fail();
     if(b.roomNightPrices&&(b.roomNightPrices.length!==1||Date.parse(stay.checkOut)-Date.parse(stay.checkIn)!==86400000||
       b.roomNightPrices[0].roomId!==stay.roomIds[0]||b.roomNightPrices[0].date!==stay.checkIn||b.roomNightPrices[0].amountCents!==b.totalCents))fail();
     refs.add(l.externalOrderId);bookingIds.add(b.id);
     const next=correctedBooking(t,e.status);reconciledAmount(next);corrected.push(next);
    }
    if(Math.min(...g.targets.map(t=>Date.parse(t.booking.stays[0].checkIn)))!==Date.parse(e.checkIn)||
     Math.max(...g.targets.map(t=>Date.parse(t.booking.stays[0].checkOut)))!==Date.parse(e.checkOut))fail();
   }
   reconciledFinanceAmounts(corrected);
  }
 }catch{fail();}
 return m;
}
export function correctedBooking(t,status){
 const b=structuredClone(t.booking);b.version++;b.totalCents=t.amount.netCents;b.status=status;
 b.sourceCalendar={platform:'airbnb',externalOrderNo:t.amount.externalOrderNo};b.sourceAmountReconciliation=structuredClone(t.amount);
 if(b.roomNightPrices)b.roomNightPrices[0].amountCents=b.totalCents;
 return b;
}
export function importedAmountSql(manifest,dryRun=true){
 const encoded=Buffer.from(JSON.stringify(validateImportedAmounts(manifest))).toString('base64');
 return `BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $repair$
DECLARE m jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
 p jsonb; g jsonb; t jsonb; s jsonb; original jsonb; b jsonb; l jsonb; patched jsonb; event_json jsonb; audit_json jsonb;
 pid uuid; next_inventory integer; at_iso text;
BEGIN
 PERFORM set_config('lock_timeout','5000ms',true);
 FOR p IN SELECT value FROM jsonb_array_elements(m->'properties') ORDER BY value->>'propertyId' LOOP
  pid:=(p->>'propertyId')::uuid;
  SELECT state_json INTO STRICT s FROM iron_gate.property_state WHERE property_id=pid AND authority_epoch=1
   AND inventory_version=(p->>'expectedInventoryVersion')::integer FOR UPDATE;
  original:=s;next_inventory:=(p->>'expectedInventoryVersion')::integer+1;
  IF s->>'propertyId' IS DISTINCT FROM pid::text OR s->>'readOnly' IS DISTINCT FROM 'false' OR
   (s->>'authorityEpoch')::integer IS DISTINCT FROM 1 OR (s->>'version')::integer IS DISTINCT FROM next_inventory-1 OR
   EXISTS(SELECT 1 FROM iron_gate.audit_log al WHERE al.property_id=pid AND al.audit_json->>'requestKey'=m->>'requestKey') THEN
   RAISE EXCEPTION 'AIRBNB_SWEEP_STATE_CONFLICT'; END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(p->'groups') LOOP
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(s->'bookings') x WHERE
     (x->'sourceCalendar'->>'externalOrderNo'=g->'evidence'->>'orderId' OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(x->'sweetfunSnapshot'->'rows',x->'offlandSnapshot'->'rows','[]')) r
       WHERE r->'values'->>(CASE WHEN p->>'sourceProperty'='sweetfun' THEN 13 ELSE 16 END)=g->'evidence'->>'orderId'))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(g->'targets') y WHERE y->'booking'->>'id'=x->>'id')) THEN
     RAISE EXCEPTION 'AIRBNB_SWEEP_INCOMPLETE_GROUP'; END IF;
   FOR t IN SELECT value FROM jsonb_array_elements(g->'targets') LOOP
    SELECT x INTO STRICT b FROM jsonb_array_elements(s->'bookings') x WHERE x->>'id'=t->'booking'->>'id';
    SELECT x INTO STRICT l FROM jsonb_array_elements(s->'sourceLinks') x WHERE x->>'bookingId'=b->>'id';
    IF b IS DISTINCT FROM t->'booking' OR l IS DISTINCT FROM t->'link' THEN RAISE EXCEPTION 'AIRBNB_SWEEP_TARGET_DRIFT'; END IF;
    patched:=b||jsonb_build_object('version',(b->>'version')::integer+1,'totalCents',t->'amount'->'netCents',
     'status',g->'evidence'->>'status','sourceCalendar',jsonb_build_object('platform','airbnb','externalOrderNo',g->'evidence'->>'orderId'),
     'sourceAmountReconciliation',t->'amount');
    IF b ? 'roomNightPrices' THEN patched:=jsonb_set(patched,'{roomNightPrices,0,amountCents}',t->'amount'->'netCents'); END IF;
    IF (patched-'version'-'totalCents'-'status'-'sourceCalendar'-'sourceAmountReconciliation'-'roomNightPrices') IS DISTINCT FROM
       (b-'version'-'totalCents'-'status'-'sourceCalendar'-'sourceAmountReconciliation'-'roomNightPrices') THEN RAISE EXCEPTION 'AIRBNB_SWEEP_UNEXPECTED_BOOKING_CHANGE'; END IF;
    s:=jsonb_set(s,'{bookings}',(SELECT jsonb_agg(CASE WHEN x->>'id'=b->>'id' THEN patched ELSE x END ORDER BY n) FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY AS rows(x,n)));
    s:=jsonb_set(s,'{sourceLinks}',(SELECT jsonb_agg(CASE WHEN x->>'bookingId'=b->>'id' THEN x||jsonb_build_object('lastAppliedBookingVersion',(b->>'version')::integer+1) ELSE x END ORDER BY n) FROM jsonb_array_elements(s->'sourceLinks') WITH ORDINALITY AS rows(x,n)));
    at_iso:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    event_json:=jsonb_build_object('eventId',gen_random_uuid()::text,'at',at_iso,'type','source.facts_enriched','propertyId',pid::text,
      'bookingId',b->>'id','bookingVersion',(b->>'version')::integer+1,'inventoryVersion',next_inventory);
    audit_json:=jsonb_build_object('auditId',gen_random_uuid()::text,'at',at_iso,'type','source.facts_enriched','workspaceId',s->>'workspaceId',
      'propertyId',pid::text,'bookingId',b->>'id','bookingVersion',(b->>'version')::integer+1,'bookingStatus',patched->>'status',
      'inventoryVersion',next_inventory,'actorOrigin','system','actorClientId','maintenance','actorSubjectId','owner-authorized-airbnb-audit',
      'actorGrantId',NULL,'requestKey',m->>'requestKey','repairKind','verified_airbnb_imported_amounts_v2','evidence',g->'evidence',
      'groupId',g->>'groupId','financialChangeApplied',true,'paymentEventsCreated',false,'beforeTotalCents',b->'totalCents',
      'afterTotalCents',patched->'totalCents','beforeStatus',b->>'status','afterStatus',patched->>'status');
    INSERT INTO iron_gate.outbox(event_id,property_id,event_json) VALUES((event_json->>'eventId')::uuid,pid,event_json);
    INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json) VALUES((audit_json->>'auditId')::uuid,pid,audit_json);
   END LOOP;
  END LOOP;
  s:=jsonb_set(s,'{version}',to_jsonb(next_inventory));
  IF (s-'bookings'-'sourceLinks'-'version') IS DISTINCT FROM (original-'bookings'-'sourceLinks'-'version') THEN RAISE EXCEPTION 'AIRBNB_SWEEP_UNEXPECTED_STATE_CHANGE'; END IF;
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=next_inventory,updated_at=now()
    WHERE property_id=pid AND inventory_version=next_inventory-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'AIRBNB_SWEEP_VERSION_DRIFT'; END IF;
 END LOOP;
END $repair$;
${dryRun?'ROLLBACK;':'COMMIT;'}`;
}
if(process.argv[1]?.endsWith('reconcile-airbnb-imported-amounts.mjs')){
 const [mode,path]=process.argv.slice(2);if(!['dry-run','apply'].includes(mode)||!path)throw Error('MODE_AND_PRIVATE_MANIFEST_REQUIRED');
 process.stdout.write(importedAmountSql(JSON.parse(readFileSync(path,'utf8')),mode==='dry-run'));
}
