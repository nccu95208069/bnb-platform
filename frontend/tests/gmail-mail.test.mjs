import test from 'node:test';
import assert from 'node:assert/strict';
import { gmailAccess, gmailMessage, mailSender } from '../src/lib/workspace-auth/gmail.ts';
import { configureGmailOAuth, configureMail, mailStatus, sendInvitation } from '../src/lib/workspace-auth/mail.ts';
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
test('isolated acceptance requires its own sender and emits links only to the candidate origin',async t=>{
 const names=['CUSTOMER_ISOLATED_ACCEPTANCE','CUSTOMER_ACCEPTANCE_SENDER_EMAIL','CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS',
  'CUSTOMER_WORKSPACE_NAMESPACE','WORKSPACE_AUTH_NAMESPACE','CUSTOMER_DEPLOYMENT_LINKS','CUSTOMER_DEPLOYMENT_ORIGIN',
  'KV_REST_API_URL','KV_REST_API_TOKEN','CALENDAR_OWNER_SESSION_SECRET'];
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 t.after(()=>{for(const name of names) {
  if(saved[name]===undefined) delete process.env[name];
  else process.env[name]=saved[name];
 }});
 process.env.CUSTOMER_ISOLATED_ACCEPTANCE='true';
 delete process.env.CUSTOMER_ACCEPTANCE_SENDER_EMAIL;
 assert.throws(mailSender,/MAIL_NOT_CONFIGURED/);
 await assert.rejects(configureMail('abcdefghijklmnop'),/MAIL_NOT_CONFIGURED/);
 process.env.CUSTOMER_ACCEPTANCE_SENDER_EMAIL='sweetfuntw@gmail.com';
 assert.throws(mailSender,/MAIL_NOT_CONFIGURED/);
 process.env.CUSTOMER_ACCEPTANCE_SENDER_EMAIL='pilot-sender@example.test';
 process.env.CUSTOMER_ACCEPTANCE_EMAIL_RECIPIENTS='["pilot-sender@example.test","test-member@example.test"]';
 process.env.CUSTOMER_WORKSPACE_NAMESPACE='bnb:acceptance:pilot-20261013';
 process.env.WORKSPACE_AUTH_NAMESPACE='sweetfun-os:acceptance:pilot-20261013';
 process.env.CUSTOMER_DEPLOYMENT_LINKS='true';
 process.env.CUSTOMER_DEPLOYMENT_ORIGIN='https://sweetfun-acceptance.vercel.app';
 process.env.KV_REST_API_URL='https://redis.invalid';process.env.KV_REST_API_TOKEN='synthetic';
 process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);
 const values=new Map(),sent=[];let mailbox='pilot-sender@example.test';
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='https://redis.invalid') {const [cmd,key,value]=JSON.parse(options.body);if(cmd==='SET')values.set(key,value);return Response.json({result:cmd==='GET'?values.get(key):'OK'});}
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic-access',scope:'https://www.googleapis.com/auth/gmail.send'});
  if(url.endsWith('/profile'))return Response.json({emailAddress:mailbox});
  if(url.endsWith('/messages/send')){sent.push(Buffer.from(JSON.parse(options.body).raw,'base64url').toString());return Response.json({id:'synthetic-message'});}
  throw new Error('unexpected endpoint');
 });
 assert.equal(mailSender(),'pilot-sender@example.test');
 assert.equal((await mailStatus()).oauthRequired,true);
 await configureGmailOAuth(config);
 assert.match(sent[0],/From: Sweetfun OS <pilot-sender@example.test>/);
 await sendInvitation('test-member@example.test','candidate-token');
 assert.match(sent[1],/From: Sweetfun OS <pilot-sender@example.test>/);
 assert.match(Buffer.from(sent[1].split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString(),/sweetfun-acceptance.vercel.app\/activate#candidate-token/);
 assert.doesNotMatch(sent[1],/sweetfuntw@gmail.com|sweetfun-os.vercel.app\/activate/);
 mailbox='sweetfuntw@gmail.com';
 await assert.rejects(sendInvitation('test-member@example.test','second-token'),/MAIL_SENDER_MISMATCH/);
});
