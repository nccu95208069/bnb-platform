import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailAccess, gmailMessage } from '../src/lib/workspace-auth/gmail.ts';
import { configureGmailOAuth, mailStatus, sendInvitation } from '../src/lib/workspace-auth/mail.ts';
const config={clientId:'synthetic-client',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh'};

test('authorized Gmail setup encrypts credentials and invitations use the confirmed sender',async t=>{
 process.env.CALENDAR_OWNER_SESSION_SECRET='a'.repeat(64);
 process.env.KV_REST_API_URL='https://redis.invalid';process.env.KV_REST_API_TOKEN='synthetic';
 const values=new Map(),sent=[];let mailbox='sweetfuntw@gmail.com',scope='https://www.googleapis.com/auth/gmail.send',failRefresh=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='https://redis.invalid') {const [cmd,key,value]=JSON.parse(options.body);if(cmd==='SET')values.set(key,value);return Response.json({result:cmd==='GET'?values.get(key):'OK'});}
  if(url==='https://oauth2.googleapis.com/token') {
   assert.equal(options.body.get('refresh_token'),config.refreshToken);
   return failRefresh?Response.json({secret:'must not leak'},{status:401}):Response.json({access_token:'synthetic-access',scope});
  }
  assert.equal(options.headers.Authorization,'Bearer synthetic-access');
  if(url.endsWith('/profile'))return Response.json({emailAddress:mailbox});
  if(url.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(options.body).raw,'base64url').toString());return Response.json({id:'synthetic-message'});}
  throw new Error('unexpected endpoint');
 });
 const setup=await configureGmailOAuth(config);assert.equal(setup.configured,true);assert.equal(sent.length,1);
 assert.match(sent[0],/To: sweetfuntw@gmail.com/);
 const raw=[...values.values()][0];assert.ok(!raw.includes(config.refreshToken));assert.ok(!raw.includes(config.clientSecret));
 const status=await mailStatus();assert.equal(status.method,'gmail_oauth');assert.ok(!JSON.stringify(status).includes('secret'));
 await sendInvitation('test-member@example.test','synthetic-token');assert.equal(sent.length,2);
 assert.match(sent[1],/From: Sweetfun OS <sweetfuntw@gmail.com>/);assert.match(sent[1],/To: test-member@example.test/);
 assert.match(Buffer.from(sent[1].split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString(),/\/activate#synthetic-token/);
 mailbox='other@example.test';await assert.rejects(sendInvitation('test-member@example.test','token'),/MAIL_SENDER_MISMATCH/);assert.equal(sent.length,2);
 mailbox='sweetfuntw@gmail.com';scope='https://www.googleapis.com/auth/gmail.readonly';await assert.rejects(gmailAccess(config),/MAIL_FAILED/);
 scope='https://www.googleapis.com/auth/gmail.send';failRefresh=true;await assert.rejects(gmailAccess(config),{message:'MAIL_FAILED'});
 assert.equal(sent.length,2);
});
test('MIME preserves Chinese text and rejects header injection',()=>{
 const mime=Buffer.from(gmailMessage('member@example.test','測試主旨','中文\n內容'),'base64url').toString();
 assert.equal(Buffer.from(mime.split('\r\n\r\n')[1],'base64').toString(),'中文\n內容');
 assert.throws(()=>gmailMessage('member@example.test\r\nBcc:x@example.test','test','body'),/INVALID_INPUT/);
 assert.throws(()=>gmailMessage('member@example.test','test\r\nBcc:x','body'),/INVALID_INPUT/);
});
