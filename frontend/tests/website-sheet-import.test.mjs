import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import XLSX from 'xlsx';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { addDays } from '../src/lib/website-booking/config.ts';
import { stageImportFile } from '../src/lib/customer-workspaces/file-import.ts';
import { sourceFor } from '../src/lib/customer-workspaces/customer-google.ts';
import { previewImport, commitImport, undoImport } from '../src/lib/customer-workspaces/sheet-import.ts';
import { setWebsiteSales } from '../src/lib/website-booking/management.ts';

function bookingRows(f, extra = []) {
 return [['入住日期','退房日期','房間','姓名','訂單編號'],
  [f.stay.checkIn,addDays(f.stay.checkIn,1),'101','Synthetic OTA','OTA-1'],...extra];
}
function bytes(rows, kind) {
 if(kind==='csv') return Buffer.from(rows.map(row=>row.join(',')).join('\n')+'\n');
 const book=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),'Bookings');
 return XLSX.write(book,{type:'buffer',bookType:'xlsx'});
}
async function imported(f, kind, mappingExtra = {}, rows = bookingRows(f)) {
 const args=[f.store,f.account.id,f.binding.slug,f.binding.propertyId];
 const roomId=f.binding.physicalMappings[0].roomIds[0];
 const staged=await stageImportFile(...args,bytes(rows,kind),`orders.${kind}`);
 const source=await sourceFor(...args,staged.tabs[0].sourceId);
 const mapping={headerRow:1,columns:{checkIn:0,checkOut:1,rooms:2,guestName:3,externalId:4,total:-1,received:-1},
  roomMap:{'101':[roomId]},granularity:'order',amountBasis:'none',receivedMeaning:'none',currency:'TWD',
  from:f.config.opensOn,coverageTo:addDays(f.config.closesOn,1),coverageConfirmed:true,...mappingExtra};
 const preview=await previewImport(...args,source,mapping);
 const selected=preview.rows.filter(row=>!row.issues.length).map(row=>row.row);
 const batch=await commitImport(...args,preview.id,selected);
 return {args,roomId,preview,batch};
}
async function enable(f) {
 return setWebsiteSales(f.store,f.account.id,f.binding.slug,
  {action:'sales',bindingId:f.binding.id,revision:f.binding.revision,enabled:true,confirmedStaticSource:true,requestKey:randomUUID()});
}

for (const kind of ['csv','xlsx']) test(`${kind} with owner-confirmed source coverage blocks sold nights and permits later verified website sales`,async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 const {roomId}=await imported(f,kind);
 const workspace=await f.workspace();
 assert.equal(workspace.properties[0].setup.mode,'sheet');
 assert.equal(workspace.properties[0].setup.coverageTo,addDays(f.config.closesOn,1));
 assert.deepEqual(workspace.bookings[0].roomIds,[roomId]);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await enable(f);
 assert.equal((await f.call('bootstrap')).state,'ready');
 assert.equal((await f.call('availability',{...f.stay,checkOut:addDays(f.stay.checkIn,1)})).options[0].availableUnits,0);
 await assert.rejects(f.quote({checkOut:addDays(f.stay.checkIn,1)}),/ROOM_CONFLICT/);
});

test('an unconfirmed or too-short Sheet/CSV source interval never opens the website',async()=>{
 const unconfirmed=await websiteFixture({activateSales:false,mode:'rooms'});
 await imported(unconfirmed,'csv',{coverageTo:undefined,coverageConfirmed:undefined});
 await assert.rejects(enable(unconfirmed),/LEGACY_INTEGRATION_REQUIRED/);
 const short=await websiteFixture({activateSales:false,mode:'rooms'});
 await imported(short,'csv',{coverageTo:addDays(short.config.closesOn,-1)});
 await assert.rejects(enable(short),/SOURCE_COVERAGE/);
});

test('an owner-scoped Google Sheet snapshot uses the same coverage, reimport and undo gates',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 const args=[f.store,f.account.id,f.binding.slug,f.binding.propertyId];
 const source={spreadsheetId:'synthetic-google-sheet-000000',sheetId:0,title:'Synthetic Google Sheet',rows:bookingRows(f)};
 const id=randomUUID();
 await f.store.commit([{key:`sheet-source:${id}`,before:null,after:{id,accountId:f.account.id,
  workspaceId:f.binding.workspaceId,propertyId:f.binding.propertyId,expiresAt:Date.now()+3600000,source}}]);
 const scoped=await sourceFor(...args,id);
 const roomId=f.binding.physicalMappings[0].roomIds[0];
 const mapping={headerRow:1,columns:{checkIn:0,checkOut:1,rooms:2,guestName:3,externalId:4,total:-1,received:-1},
  roomMap:{'101':[roomId]},granularity:'order',amountBasis:'none',receivedMeaning:'none',currency:'TWD',
  from:f.config.opensOn,coverageTo:addDays(f.config.closesOn,1),coverageConfirmed:true};
 const preview=await previewImport(...args,scoped,mapping);
 await commitImport(...args,preview.id,preview.rows.filter(row=>!row.issues.length).map(row=>row.row));
 assert.equal((await f.call('bootstrap')).state,'unavailable');
 await enable(f);
 assert.equal((await f.call('availability',{...f.stay,checkOut:addDays(f.stay.checkIn,1)})).options[0].availableUnits,0);
 const day=addDays(f.stay.checkOut,2), nextId=randomUUID();
 const nextSource={...source,rows:[...source.rows,[day,addDays(day,1),'101','Synthetic OTA','OTA-2']]};
 await f.store.commit([{key:`sheet-source:${nextId}`,before:null,after:{id:nextId,accountId:f.account.id,
  workspaceId:f.binding.workspaceId,propertyId:f.binding.propertyId,expiresAt:Date.now()+3600000,source:nextSource}}]);
 const nextPreview=await previewImport(...args,await sourceFor(...args,nextId),mapping);
 const batch=await commitImport(...args,nextPreview.id,nextPreview.rows.filter(row=>!row.issues.length).map(row=>row.row));
 assert.equal(batch.bookingIds.length,1);
 assert.equal((await f.call('availability',{...f.stay,checkIn:day,checkOut:addDays(day,1)})).options[0].availableUnits,0);
 await undoImport(...args,batch.id,(await f.workspace()).version);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});

test('same-file reimport adds newly sold OTA night once; undo closes website readiness',async()=>{
 const f=await websiteFixture({activateSales:false,mode:'rooms'});
 await imported(f,'csv');await enable(f);
 const day=addDays(f.stay.checkOut,2);
 const updated=await imported(f,'csv',{},[...bookingRows(f),[day,addDays(day,1),'101','Synthetic OTA','OTA-2']]);
 assert.equal(updated.batch.bookingIds.length,1);
 assert.equal((await f.call('availability',{...f.stay,checkIn:day,checkOut:addDays(day,1)})).options[0].availableUnits,0);
 const current=await f.workspace();
 await undoImport(...updated.args,updated.batch.id,current.version);
 assert.equal((await f.call('bootstrap')).state,'unavailable');
});
