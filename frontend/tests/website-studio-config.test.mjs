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
  const oldScope={client_id:'legacy',site_id:'existing-site'},newScope={client_id:'studio',site_id:'studio-a'};
  process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES=JSON.stringify([oldScope]);process.env.WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES=JSON.stringify([newScope]);
  assert.deepEqual(emailDeliverySiteScopes(),[oldScope,newScope]);
  process.env.WEBSITE_BOOKING_STUDIO_EMAIL_SITE_SCOPES=JSON.stringify([oldScope]);assert.throws(()=>emailDeliverySiteScopes(),/EMAIL_DELIVERY_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS=JSON.stringify([legacy]);assert.throws(()=>serviceClient(studioToken),/WEBSITE_BOOKING_UNAVAILABLE/);
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS='{}';assert.throws(()=>serviceClient(legacyToken),/WEBSITE_BOOKING_UNAVAILABLE/);
 }finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k]}}
});
