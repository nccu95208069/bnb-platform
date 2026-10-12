import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import XLSX from 'xlsx';
import * as Upload from '../src/app/api/customer-workspaces/[slug]/import/upload/route.ts';
import * as Import from '../src/app/api/customer-workspaces/[slug]/import/route.ts';
import { store as routeStore } from '../src/lib/customer-workspaces/http.ts';
import { sessionFor } from '../src/lib/customer-workspaces/auth.ts';
import { memoryStore, websiteFixture } from './helpers/website-booking-fixture.mjs';
import { addDays } from '../src/lib/website-booking/config.ts';
import { setWebsiteSales } from '../src/lib/website-booking/management.ts';
import { randomUUID } from 'node:crypto';

const origin='https://test.local';
const csv=(stay)=>`入住日期,退房日期,房間,姓名,訂單編號\n${stay.checkIn},${addDays(stay.checkIn,1)},101,Synthetic OTA,OTA-1\n`;
function request(path,{cookie,body,originHeader=origin,headers={}}={}) {
 return new NextRequest(origin+path,{method:'POST',headers:{origin:originHeader,...(cookie?{cookie}:{}),...headers},body});
}
test('file upload route checks the owner and property before reading bytes, then previews and commits within that tenant',async t=>{
 const store=memoryStore();
 const first=await websiteFixture({store,activateSales:false,mode:'rooms',siteId:'synthetic:upload-a',ownerEmail:'upload-a@example.invalid'});
 const second=await websiteFixture({store,activateSales:false,mode:'rooms',siteId:'synthetic:upload-b',ownerEmail:'upload-b@example.invalid'});
 for(const method of ['read','commit','limit']) t.mock.method(routeStore,method,store[method]);
 const firstCookie=`bnb_customer_session=${sessionFor(first.account)}`;
 const secondCookie=`bnb_customer_session=${sessionFor(second.account)}`;
 const route=`/api/customer-workspaces/${first.binding.slug}/import`;
 const context={params:Promise.resolve({slug:first.binding.slug})};
 const query=new URLSearchParams({propertyId:first.binding.propertyId,filename:'bookings.csv'});
 const upload=`${route}/upload?${query}`;
 const content=csv(first.stay);
 assert.equal((await Upload.POST(request(upload,{body:content}),context)).status,401);
 assert.equal((await Upload.POST(request(upload,{body:content,cookie:firstCookie,originHeader:'https://other.invalid'}),context)).status,403);
 assert.equal((await Upload.POST(request(upload,{body:content,cookie:secondCookie}),context)).status,404);
 const wrong=new URLSearchParams(query);wrong.set('propertyId',second.binding.propertyId);
 assert.equal((await Upload.POST(request(`${route}/upload?${wrong}`,{body:'not a csv',cookie:firstCookie}),context)).status,404);
 assert.equal((await Upload.POST(request(upload,{body:content,cookie:firstCookie,headers:{'content-length':'99999999'}}),context)).status,400);
 const uploaded=await Upload.POST(request(upload,{body:content,cookie:firstCookie}),context);
 assert.equal(uploaded.status,200);
 assert.equal(uploaded.headers.get('cache-control'),'private, no-store');
 const staged=await uploaded.json();
 const sourceId=staged.tabs[0].sourceId;
 const api=(cookie,input)=>Import.POST(request(route,{body:JSON.stringify(input),cookie}),context);
 assert.equal((await api(secondCookie,{action:'file-source',propertyId:first.binding.propertyId,sourceId})).status,404);
 const source=await api(firstCookie,{action:'file-source',propertyId:first.binding.propertyId,sourceId});
 assert.equal(source.status,200);
 const roomId=first.binding.physicalMappings[0].roomIds[0];
 const mapping={headerRow:1,columns:{checkIn:0,checkOut:1,rooms:2,guestName:3,externalId:4,total:-1,received:-1},
  roomMap:{'101':[roomId]},granularity:'order',amountBasis:'none',receivedMeaning:'none',currency:'TWD',
  from:first.config.opensOn,coverageTo:addDays(first.config.closesOn,1),coverageConfirmed:true};
 const previewResponse=await api(firstCookie,{action:'preview',propertyId:first.binding.propertyId,sourceId,mapping});
 assert.equal(previewResponse.status,200);
 const preview=await previewResponse.json();
 assert.equal(preview.rows.length,1);
 assert.deepEqual(preview.rows[0].issues,[]);
 const commit={action:'commit',propertyId:first.binding.propertyId,previewId:preview.id,selected:[preview.rows[0].row],confirmed:true};
 const committed=await api(firstCookie,commit);
 assert.equal(committed.status,200);
 assert.equal((await api(firstCookie,commit)).status,200);
 assert.equal((await first.workspace()).bookings.length,1);
 assert.equal((await second.workspace()).bookings.length,0);
 assert.equal((await first.call('bootstrap')).state,'unavailable');
 await setWebsiteSales(store,first.account.id,first.binding.slug,{action:'sales',bindingId:first.binding.id,
  revision:first.binding.revision,enabled:true,confirmedStaticSource:true,requestKey:randomUUID()});
 assert.equal((await first.call('availability',{...first.stay,checkOut:addDays(first.stay.checkIn,1)})).options[0].availableUnits,0);
 assert.equal((await second.call('bootstrap')).state,'unavailable');
 const workbook=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
  ['入住日期','退房日期','房間','姓名','訂單編號'],
  [second.stay.checkIn,addDays(second.stay.checkIn,1),'101','Synthetic OTA','OTA-2'],
 ]),'Bookings');
 const excel=XLSX.write(workbook,{type:'buffer',bookType:'xlsx'});
 const secondRoute=`/api/customer-workspaces/${second.binding.slug}/import`;
 const secondContext={params:Promise.resolve({slug:second.binding.slug})};
 const excelQuery=new URLSearchParams({propertyId:second.binding.propertyId,filename:'bookings.xlsx'});
 const uploadedExcel=await Upload.POST(request(`${secondRoute}/upload?${excelQuery}`,{body:excel,cookie:secondCookie}),secondContext);
 assert.equal(uploadedExcel.status,200);
 const excelSource=(await uploadedExcel.json()).tabs[0].sourceId;
 const excelRead=await Import.POST(request(secondRoute,{body:JSON.stringify({action:'file-source',propertyId:second.binding.propertyId,sourceId:excelSource}),cookie:secondCookie}),secondContext);
 assert.equal(excelRead.status,200);
 assert.equal((await excelRead.json()).rows[1][0],second.stay.checkIn);
 const secondRoom=second.binding.physicalMappings[0].roomIds[0];
 const secondMapping={...mapping,roomMap:{'101':[secondRoom]},from:second.config.opensOn,coverageTo:addDays(second.config.closesOn,1)};
 const secondPreviewResponse=await Import.POST(request(secondRoute,{body:JSON.stringify({action:'preview',propertyId:second.binding.propertyId,
  sourceId:excelSource,mapping:secondMapping}),cookie:secondCookie}),secondContext);
 assert.equal(secondPreviewResponse.status,200);
 const secondPreview=await secondPreviewResponse.json();
 const secondCommit=await Import.POST(request(secondRoute,{body:JSON.stringify({action:'commit',propertyId:second.binding.propertyId,
  previewId:secondPreview.id,selected:[secondPreview.rows[0].row],confirmed:true}),cookie:secondCookie}),secondContext);
 assert.equal(secondCommit.status,200);
 await setWebsiteSales(store,second.account.id,second.binding.slug,{action:'sales',bindingId:second.binding.id,
  revision:second.binding.revision,enabled:true,confirmedStaticSource:true,requestKey:randomUUID()});
 assert.equal((await second.call('availability',{...second.stay,checkOut:addDays(second.stay.checkIn,1)})).options[0].availableUnits,0);
 assert.equal((await first.workspace()).bookings.length,1);
 assert.equal((await second.workspace()).bookings.length,1);
});
