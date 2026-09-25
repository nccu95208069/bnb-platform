import {configuredStore} from '../sheet-monitor/store.ts';
import {publicSnapshot} from '../sheet-monitor/reconcile.ts';
import {SWEETFUN_SOURCE} from '../booking-sources/config.ts';
export async function readLiveSource(){
 // Deliberately no seed fallback, credential reader, sheet writer, or private-name lookup.
 const state=await configuredStore(SWEETFUN_SOURCE).read();
 if(!state||!state.checkedAt||!Number.isFinite(Date.parse(state.checkedAt))||Date.parse(state.checkedAt)>Date.now()+60000)throw Error('SOURCE_UNAVAILABLE');
 const snapshot=publicSnapshot(state,new Date().toISOString());
 if(snapshot.source.sync?.status!=='healthy')throw Error('SOURCE_UNAVAILABLE');
 if(snapshot.bookings.some(b=>b.property_id!=='sweetfun'||!SWEETFUN_SOURCE.property.rooms.some(r=>r.number===b.room_number)))throw Error('SOURCE_INVALID');
 return snapshot;
}
