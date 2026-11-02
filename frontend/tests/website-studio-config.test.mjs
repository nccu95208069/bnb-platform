import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../src/lib/customer-workspaces/auth.ts';
import { serviceClient, permittedSite } from '../src/lib/website-booking/config.ts';
import { emailDeliverySiteScopes } from '../src/lib/website-booking/delivery.ts';
test('studio client and email grants extend exact scopes without changing legacy credentials',()=>{
 const keys=['WEBSITE_BOOKING_CLIENTS','WEBSITE_BOOKING_STUDIO_CLIENTS','WEBSITE_BOOKING_EMAIL_SITE_SCOPES','WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES'];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  const legacyToken='legacy-test-editor-token-with-32-characters',studioToken='studio-test-editor-token-with-32-characters';
  const legacy={id:'legacy',token_sha256:digest(legacyToken),site_ids:['existing-site'],editor_origin:'https://editor.test'};
  const studio={id:'studio',token_sha256:digest(studioToken),site_ids:['studio-a','studio-b'],editor_origin:'https://editor.test'};
  process.env.WEBSITE_BOOKING_CLIENTS=JSON.stringify([legacy]);process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([studio]);
  assert.deepEqual(serviceClient(legacyToken),legacy);assert.deepEqual(serviceClient(studioToken),studio);
  assert.throws(()=>permittedSite(serviceClient(studioToken),'existing-site'),/FORBIDDEN/);
  assert.throws(()=>permittedSite(serviceClient(legacyToken),'studio-a'),/FORBIDDEN/);
  const newSite='5a2db0b2-87d9-4f72-a20b-82890d944e20';
  const dynamic={...studio,site_ids:[],allow_new_sites:true};
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([dynamic]);
  assert.equal(permittedSite(serviceClient(studioToken),newSite),newSite);
  assert.throws(()=>permittedSite(serviceClient(studioToken),'arbitrary-site'),/FORBIDDEN/);
  process.env.WEBSITE_BOOKING_CLIENTS=JSON.stringify([{...legacy,allow_new_sites:true}]);
  assert.throws(()=>serviceClient(legacyToken),/WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_CLIENTS=JSON.stringify([legacy]);
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([studio]);
  const oldScope={client_id:'legacy',site_id:'existing-site'},newScope={client_id:'studio',site_id:'studio-a'};
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES=JSON.stringify([oldScope]);process.env.WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES=JSON.stringify([newScope]);
  assert.deepEqual(emailDeliverySiteScopes(),[oldScope,newScope]);
  process.env.WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES=JSON.stringify([oldScope]);assert.throws(()=>emailDeliverySiteScopes(),/EMAIL_DELIVERY_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([legacy]);assert.throws(()=>serviceClient(studioToken),/WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS='{}';assert.throws(()=>serviceClient(legacyToken),/WEBSITE_BOOKING_UNAVAILABLE/);
 }finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k]}}
});

test('explicit Studio origin admission preserves existing credentials and never expands a legacy client',()=>{
 const keys=['WEBSITE_BOOKING_CLIENTS','WEBSITE_BOOKING_STUDIO_CLIENTS','WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS'];
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  const token='synthetic-studio-existing-secret-token',oldToken='synthetic-legacy-existing-secret-token';
  const origin='https://studio.example.invalid';
  const studio={id:'studio',token_sha256:digest(token),site_ids:['original-site'],editor_origin:origin};
  const legacy={id:'legacy',token_sha256:digest(oldToken),site_ids:['legacy-site'],editor_origin:origin};
  process.env.WEBSITE_BOOKING_CLIENTS=JSON.stringify([legacy]);process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([studio]);
  const site='5a2db0b2-87d9-4f72-a20b-82890d944e20';
  delete process.env.WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS;
  assert.throws(()=>permittedSite(serviceClient(token),site),/FORBIDDEN/);
  process.env.WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS=JSON.stringify([origin]);
  assert.equal(permittedSite(serviceClient(token),site),site);
  assert.equal(permittedSite(serviceClient(token),'original-site'),'original-site');
  assert.deepEqual(serviceClient(oldToken),legacy);
  assert.throws(()=>permittedSite(serviceClient(oldToken),site),/FORBIDDEN/);
  assert.throws(()=>permittedSite(serviceClient(token),'another-legacy-site'),/FORBIDDEN/);
  assert.throws(()=>serviceClient('wrong-token'),/UNAUTHORIZED/);
  for(const value of ['{}','["https://unknown.example.invalid"]',JSON.stringify([origin,origin]),'["http://studio.example.invalid"]']){
   process.env.WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS=value;
   assert.throws(()=>serviceClient(token),/WEBSITE_BOOKING_UNAVAILABLE/);
  }
 }finally{for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});
