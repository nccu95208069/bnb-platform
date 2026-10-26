import test from 'node:test';
import assert from 'node:assert/strict';
import {sendStudioAuthMail,sealMailPassword} from '../src/lib/workspace-auth/mail.ts';
import {failure} from '../src/lib/website-booking/http.ts';
test('Studio password templates use the configured Gmail sender and support new recipients without lifecycle delivery permission',async t=>{
 process.env.CALENDAR_OWNER_SESSION_SECRET='a'.repeat(64);process.env.KV_REST_API_URL='https://redis.invalid';process.env.KV_REST_API_TOKEN='synthetic';process.env.CUSTOMER_ISOLATED_ACCEPTANCE='true';process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS='[]';process.env.CUSTOMER_WORKSPACE_NAMESPACE='bnb:acceptance:password-mail';process.env.WORKSPACE_AUTH_NAMESPACE='sweetfun-os:acceptance:password-mail';
 const secret=sealMailPassword(JSON.stringify({clientId:'synthetic',clientSecret:'synthetic',refreshToken:'synthetic'})),sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='https://redis.invalid')return Response.json({result:JSON.stringify({method:'gmail_oauth',secret})});
  if(String(url).includes('oauth2.googleapis.com'))return Response.json({access_token:'synthetic',scope:'https://www.googleapis.com/auth/gmail.send'});
  if(String(url).endsWith('/profile'))return Response.json({emailAddress:'sweetfuntw@gmail.com'});
  if(String(url).endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(options.body).raw,'base64url').toString());return Response.json({id:'synthetic-'+sent.length})}
  throw Error('unexpected destination');
 });
 const templates=[['STAYFORM｜設定你的登入密碼','你剛剛要求設定 STAYFORM 登入密碼。\nhttps://studio.example.invalid/auth/reset-password#synthetic'],['STAYFORM｜重新設定密碼','你剛剛要求重新設定 STAYFORM 登入密碼。\nhttps://studio.example.invalid/auth/reset-password#synthetic'],['STAYFORM｜登入密碼已變更','你的 STAYFORM 登入密碼已於 2026-10-27 變更。'],['Stayform｜你的登入碼','你的登入碼：123456']];
 for(const [subject,text]of templates){await sendStudioAuthMail('new-owner@example.invalid',subject,text);const raw=sent.at(-1);assert.match(raw,/To: new-owner@example.invalid\r\n/);assert.match(raw,/From: Sweetfun OS <sweetfuntw@gmail.com>/);assert.equal(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString(),text)}
 await assert.rejects(sendStudioAuthMail('new-owner@example.invalid','Arbitrary email','Untrusted content'),/INVALID_INPUT/);assert.equal(sent.length,4);
});
test('public integration errors preserve generic login failures and actionable expired-link/rate-limit status',async()=>{
 for(const [code,status]of [['STUDIO_LOGIN_INVALID',401],['PASSWORD_LINK_INVALID',400],['STUDIO_PASSWORD_INVALID',400],['RATE_LIMITED',429]]){const response=failure(Error(code));assert.equal(response.status,status);assert.equal(response.headers.get('Cache-Control'),'private, no-store');assert.equal((await response.json()).code,code)}
 const response=failure(Error('private provider failure'));assert.equal(response.status,503);assert.equal(JSON.stringify(await response.json()).includes('private provider'),false);
});
