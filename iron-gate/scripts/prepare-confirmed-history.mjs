import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

// Offline, owner-confirmed historical reconciliation only. Keep manifests and
// generated SQL private. No channel operations or payment events are generated.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const fail = () => {throw Error('HISTORY_REPAIR_INVALID');};
const day = x => typeof x==='string' && /^\d{4}-\d{2}-\d{2}$/.test(x) &&
  Number.isFinite(Date.parse(x+'T00:00:00Z')) && new Date(x+'T00:00:00Z').toISOString().slice(0,10)===x;
function cells(stays) {
  if (!Array.isArray(stays)||stays.length!==1) fail();
  const s=stays[0];
  if (!day(s.checkIn)||!day(s.checkOut)||s.checkIn>=s.checkOut||s.roomIds?.length!==1||!uuid.test(s.roomIds[0])) fail();
  const count=(Date.parse(s.checkOut)-Date.parse(s.checkIn))/86400000;
  if(count>31) fail();
  return Array.from({length:count},(_,i)=>({roomId:s.roomIds[0],date:new Date(Date.parse(s.checkIn)+i*86400000).toISOString().slice(0,10)}));
}
export function validateHistory(m) {
  if(m?.schema!==1||!uuid.test(m.repairKey)||m.ownerConfirmedActualStay!==true||
    typeof m.ownerEvidenceRef!=='string'||!m.ownerEvidenceRef||!day(m.asOfDate)||
    !Array.isArray(m.properties)||!m.properties.length||m.properties.length>2) fail();
  const seen=new Set(),seenCells=new Set(),seenProperties=new Set(),seenOrders=new Set();
  for(const p of m.properties){
    if(!uuid.test(p.propertyId)||seenProperties.has(p.propertyId)||!uuid.test(p.workspaceId)||!hash.test(p.stateHash)||
      !Number.isSafeInteger(p.version)||p.version<1||p.epoch!==1||!Array.isArray(p.orders)||!p.orders.length||p.orders.length>5)fail();
    seenProperties.add(p.propertyId);
    for(const o of p.orders){
      if(!uuid.test(o.bookingId)||seen.has(o.bookingId)||seenOrders.has(o.orderId)||!/^OBE[A-Z0-9]+$/.test(o.orderId)||
        !['create','extend'].includes(o.kind)||!Number.isSafeInteger(o.totalCents)||o.totalCents<0||
        !day(o.bookedAt)||!hash.test(o.evidenceSha256)||!/^[0-9a-f]{16}$/.test(o.messageId)||
        !Number.isSafeInteger(o.internalDate)||o.internalDate<1||!hash.test(o.messageSha256)||
        typeof o.guestName!=='string'||!o.guestName.trim()||o.guestName.length>200||
        Object.keys(o).some(k=>!['kind','bookingId','orderId','totalCents','bookedAt','evidenceSha256','messageId','internalDate','messageSha256','guestName','stays','platform','externalOrderNo','beforeBooking','beforeLinks'].includes(k))) fail();
      seen.add(o.bookingId);seenOrders.add(o.orderId);o.cells=cells(o.stays);
      if(o.stays[0].checkOut>=m.asOfDate||o.bookedAt>o.stays[0].checkIn)fail();
      for(const c of o.cells){const key=p.propertyId+'|'+c.roomId+'|'+c.date;if(seenCells.has(key))fail();seenCells.add(key);}
      if(o.kind==='extend'){
        const b=o.beforeBooking;
        if(b?.id!==o.bookingId||b.propertyId!==p.propertyId||b.workspaceId!==p.workspaceId||b.status!=='confirmed'||
          b.source!=='external'||b.sourceKey!==null||b.sourceCalendar||b.channelSyncState!=='not_required'||
          b.channelOperationKey!==null||b.lineOverridePending||b.roomNightPrices?.length||b.paymentEvents?.length||
          b.guestName!==o.guestName||!Number.isSafeInteger(b.version)||b.totalCents>=o.totalCents||
          !Array.isArray(o.beforeLinks)||o.beforeLinks.length!==1||o.beforeLinks[0].bookingId!==b.id||
          o.beforeLinks[0].diverged!==false||o.beforeLinks[0].lastAppliedBookingVersion!==b.version||
          o.beforeLinks[0].tombstoneNights?.length)fail();
        const prior=cells(b.stays);
        if(prior.length>=o.cells.length||prior.some(c=>!o.cells.some(n=>n.roomId===c.roomId&&n.date===c.date)))fail();
        o.addCells=o.cells.filter(c=>!prior.some(n=>n.roomId===c.roomId&&n.date===c.date));
      }else{
        if(o.beforeBooking!==undefined||o.beforeLinks!==undefined||!['owlting','booking','agoda'].includes(o.platform)||
          !['sweetfun-calendar-sheet','offland-calendar-sheet'].includes(p.sourceSystem)||!p.sourceAccount||
          (o.externalOrderNo!==null&&!/^[A-Za-z0-9-]{1,64}$/.test(o.externalOrderNo)))fail();
        o.addCells=o.cells;
        o.sourceKey=JSON.stringify([p.sourceSystem,p.sourceAccount,'L:'+o.orderId]);
        o.sourceVersion=`gmail-v1:${o.internalDate}:${createHash('sha256').update(o.messageId).digest('hex')}`;
      }
    }
  }
  return m;
}

export function historySql(manifest,dryRun=true){
 const m=validateHistory(structuredClone(manifest));
 const encoded=Buffer.from(JSON.stringify(m)).toString('base64');
 return `BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $history$
DECLARE
 m jsonb:=convert_from(decode('${encoded}','base64'),'UTF8')::jsonb;
 p jsonb; o jsonb; s jsonb; b jsonb; prior jsonb; l jsonb; ev jsonb; au jsonb;
 n integer; idx integer; v bigint; stamp text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
BEGIN
 IF EXISTS(select 1 from iron_gate.audit_log where audit_json->>'requestKey'=m->>'repairKey') THEN
  RAISE EXCEPTION 'HISTORY_REPAIR_ALREADY_RECORDED'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(m->'properties') ORDER BY value->>'propertyId' LOOP
  SELECT state_json INTO STRICT s FROM iron_gate.property_state WHERE property_id=(p->>'propertyId')::uuid
   AND workspace_id=(p->>'workspaceId')::uuid AND authority_epoch=(p->>'epoch')::bigint
   AND inventory_version=(p->>'version')::bigint FOR UPDATE;
  IF s->'readOnly' IS DISTINCT FROM 'false'::jsonb OR encode(sha256(convert_to(s::text,'UTF8')),'hex') IS DISTINCT FROM p->>'stateHash'
   THEN RAISE EXCEPTION 'HISTORY_REPAIR_STATE_CHANGED'; END IF;
  v:=(p->>'version')::bigint;
  FOR o IN SELECT value FROM jsonb_array_elements(p->'orders') LOOP
   IF (o->'stays'->0->>'checkOut')::date >= current_date THEN RAISE EXCEPTION 'HISTORY_ONLY'; END IF;
   IF EXISTS(select 1 from jsonb_array_elements(o->'cells')c where NOT(s->'roomIds' ? (c->>'roomId')))
    THEN RAISE EXCEPTION 'HISTORY_UNKNOWN_ROOM'; END IF;
   IF EXISTS(select 1 from jsonb_array_elements(s->'bookings') x,jsonb_array_elements(x->'stays') st,jsonb_array_elements(o->'cells') c
      where x->>'id'<>o->>'bookingId' and x->>'status' in ('confirmed','held') and st->'roomIds' ? (c->>'roomId')
       and st->>'checkIn'<=c->>'date' and st->>'checkOut'>c->>'date')
    OR EXISTS(select 1 from iron_gate.occupied_room_nights x,jsonb_array_elements(o->'cells')c
      where x.property_id=(p->>'propertyId')::uuid and x.room_id=(c->>'roomId')::uuid and x.night=(c->>'date')::date and x.booking_id<>(o->>'bookingId')::uuid)
    OR EXISTS(select 1 from jsonb_array_elements(s->'fences')f,jsonb_array_elements(f->'cells')fc,jsonb_array_elements(o->'cells')c where fc=c)
    OR EXISTS(select 1 from jsonb_array_elements(s->'manualBlocks')bl,jsonb_array_elements(o->'cells')c where bl=c)
    OR EXISTS(select 1 from jsonb_array_elements(s->'operations')op,jsonb_array_elements(op->'cells')oc,jsonb_array_elements(o->'cells')c
      where op->>'state' in ('sync_pending','review_required') and oc->>'roomId'=c->>'roomId' and oc->>'date'=c->>'date')
    THEN RAISE EXCEPTION 'HISTORY_REPAIR_OCCUPANCY_CONFLICT'; END IF;
   SELECT count(*),min(ord)::integer-1,jsonb_agg(value)->0 INTO n,idx,prior
    FROM jsonb_array_elements(s->'bookings') WITH ORDINALITY x(value,ord) WHERE value->>'id'=o->>'bookingId';
   IF o->>'kind'='extend' THEN
    IF n<>1 OR prior IS DISTINCT FROM o->'beforeBooking' OR
     (select jsonb_agg(x)from jsonb_array_elements(s->'sourceLinks')x where x->>'bookingId'=o->>'bookingId') IS DISTINCT FROM o->'beforeLinks'
     THEN RAISE EXCEPTION 'HISTORY_REPAIR_TARGET_CHANGED'; END IF;
    b:=prior||jsonb_build_object('stays',o->'stays','totalCents',o->'totalCents','version',(prior->>'version')::integer+1);
    IF b-'stays'-'totalCents'-'version' IS DISTINCT FROM prior-'stays'-'totalCents'-'version' THEN RAISE EXCEPTION 'HISTORY_UNRELATED_CHANGE'; END IF;
    s:=jsonb_set(s,ARRAY['bookings',idx::text],b);
    s:=jsonb_set(s,'{sourceLinks}',(select jsonb_agg(case when x->>'bookingId'=o->>'bookingId' then x||'{"diverged":true}'::jsonb else x end order by ord)
     from jsonb_array_elements(s->'sourceLinks')with ordinality q(x,ord)));
   ELSE
    IF n<>0 OR EXISTS(select 1 from jsonb_array_elements(s->'sourceLinks')x where x->>'externalOrderId' in ('L:'||(o->>'orderId'),'Q:'||(o->>'orderId')))
     OR EXISTS(select 1 from jsonb_array_elements(s->'bookings')x where x->>'sourceKey'=o->>'sourceKey'
      or (o->>'externalOrderNo' is not null and x->'sourceCalendar'->>'externalOrderNo'=o->>'externalOrderNo')
      or EXISTS(select 1 from jsonb_array_elements(coalesce(x->'sweetfunSnapshot'->'rows',x->'offlandSnapshot'->'rows','[]'::jsonb))r
       where r->'values'->>11=o->>'orderId' or (o->>'externalOrderNo' is not null and r->>'otaAlias'=o->>'externalOrderNo')))
     THEN RAISE EXCEPTION 'HISTORY_DUPLICATE_IDENTITY'; END IF;
    IF NOT EXISTS(select 1 from jsonb_array_elements(s->'sourceGrants')g where g->>'sourceSystem'=p->>'sourceSystem'
      and g->>'sourceAccount'=p->>'sourceAccount' and g->>'active'='true') THEN RAISE EXCEPTION 'HISTORY_SOURCE_CHANGED'; END IF;
    b:=jsonb_build_object('id',o->>'bookingId','workspaceId',p->>'workspaceId','propertyId',p->>'propertyId',
     'version',1,'status','confirmed','channelSyncState','not_required','channelOperationKey',null,
     'stays',o->'stays','guestName',o->>'guestName','contact',null,'notes',null,'totalCents',o->'totalCents',
     'currency','TWD','bookedAt',o->>'bookedAt','createdAt',stamp,'source','external','sourceKey',o->>'sourceKey',
     'paymentEvents','[]'::jsonb,'sourceCalendar',jsonb_build_object('platform',o->>'platform','externalOrderNo',o->'externalOrderNo'));
    l:=jsonb_build_object('key',o->>'sourceKey','sourceSystem',p->>'sourceSystem','sourceAccount',p->>'sourceAccount',
     'externalOrderId','L:'||(o->>'orderId'),'bookingId',o->>'bookingId','sourceVersion',o->>'sourceVersion',
     'lastAppliedBookingVersion',1,'diverged',false,'tombstoneNights','[]'::jsonb);
    s:=jsonb_set(jsonb_set(s,'{bookings}',s->'bookings'||jsonb_build_array(b)),'{sourceLinks}',s->'sourceLinks'||jsonb_build_array(l));
   END IF;
   INSERT INTO iron_gate.occupied_room_nights(property_id,room_id,night,booking_id)
    SELECT (p->>'propertyId')::uuid,(c->>'roomId')::uuid,(c->>'date')::date,(o->>'bookingId')::uuid FROM jsonb_array_elements(o->'addCells')c;
   v:=v+1;
   ev:=jsonb_build_object('eventId',gen_random_uuid()::text,'at',stamp,'type',case when o->>'kind'='create' then 'booking.created' else 'booking.amended' end,
    'propertyId',p->>'propertyId','bookingId',o->>'bookingId','bookingVersion',b->'version','inventoryVersion',v);
   au:=(ev-'eventId')||jsonb_build_object('auditId',gen_random_uuid()::text,'workspaceId',p->>'workspaceId','bookingStatus','confirmed',
    'actorOrigin','system','actorSubjectId','owner-confirmed-history-maintenance','requestKey',m->>'repairKey',
    'ownerEvidenceRef',m->>'ownerEvidenceRef','providerOrderId',o->>'orderId','evidenceSha256',o->>'evidenceSha256',
    'sourceMessageId',o->>'messageId','messageSha256',o->>'messageSha256','paymentEvidence','not_reconciled',
    'priorBooking',case when o->>'kind'='extend' then prior else null end);
   INSERT INTO iron_gate.outbox(event_id,property_id,event_json)VALUES((ev->>'eventId')::uuid,(p->>'propertyId')::uuid,ev);
   INSERT INTO iron_gate.audit_log(audit_id,property_id,audit_json)VALUES((au->>'auditId')::uuid,(p->>'propertyId')::uuid,au);
  END LOOP;
  s:=jsonb_set(s,'{version}',to_jsonb(v));
  UPDATE iron_gate.property_state SET state_json=s,inventory_version=v,updated_at=now() WHERE property_id=(p->>'propertyId')::uuid;
 END LOOP;
END $history$;
SELECT property_id,inventory_version,(select count(*)from jsonb_array_elements(state_json->'bookings')b where b->>'status'='confirmed')as confirmed_orders
FROM iron_gate.property_state WHERE property_id IN (${m.properties.map(p=>"'"+p.propertyId+"'::uuid").join(',')});
${dryRun?'ROLLBACK;':'COMMIT;'}`;
}
if(process.argv[1]?.endsWith('prepare-confirmed-history.mjs')){
 const [mode,path]=process.argv.slice(2);if(!['dry-run','apply'].includes(mode)||!path)fail();
 process.stdout.write(historySql(JSON.parse(readFileSync(path,'utf8')),mode==='dry-run'));
}
