import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inviteMember,activateMember,invitedMember,updateMember} from '../src/lib/workspace-auth/members.ts';
import {createMemberSession,validMemberSession,memberPrincipal} from '../src/lib/workspace-auth/session.ts';
import {credentialMatches} from '../src/lib/owner-password.ts';
import {publicMember} from '../src/lib/workspace-auth/types.ts';
import {projectBookings} from '../src/lib/workspace-auth/projection.ts';
import {sealMailPassword,openMailPassword} from '../src/lib/workspace-auth/mail.ts';
const input={displayName:'Synthetic staff',email:'staff@example.test',role:'viewer_no_price',allProperties:false,propertyIds:['offland']};
const password='Synthetic member passphrase 2026!';
function storeFixture(){let raw=null;return {read:async()=>({raw,value:raw?JSON.parse(raw):{version:0,members:[]}}),replace:async(expected,value)=>{if(raw!==expected)throw new Error('VERSION_CONFLICT');raw=JSON.stringify(value);},limit:async()=>{}};}
function config(){process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('a'.repeat(32)).digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);}
test('invitation -> personal password -> session -> scoped private data -> suspend revokes sessions',async()=>{
 config();const store=storeFixture();let token;
 const invite=await inviteMember(store,input,async(to,link)=>{assert.equal(to,input.email);token=link;});
 assert.equal(invite.delivery,'sent');assert.equal(invite.member.status,'invited');
 const raw=(await store.read()).raw;assert.equal(raw.includes(token.split('.')[1]),false);
 const member=await activateMember(store,{token,password,confirmPassword:password});
 assert.equal(await credentialMatches(password,member.credential),true);
 assert.equal(JSON.stringify(publicMember(member)).includes('credential'),false);
 assert.equal(JSON.stringify(publicMember(member)).includes('hash'),false);
 const session=createMemberSession(member);
 assert.equal(validMemberSession(session,member),true);
 assert.equal(validMemberSession(session.slice(0,-1)+'!',member),false);
 await assert.rejects(activateMember(store,{token,password,confirmPassword:password}),/INVITE_INVALID/);
 const results=projectBookings([{id:'a',property_id:'sweetfun',room_rate:12345},{id:'b',property_id:'offland',room_rate:98765,notes:'pay 98765',nightly_amounts:[{date:'2026-09-01',amount:98765}],payments:[{amount:98765}],source_payment_label:'paid 98765'}],memberPrincipal(member));
 assert.equal(results.length,1);assert.equal(results[0].property_id,'offland');assert.equal(results[0].price_hidden,true);assert.equal(JSON.stringify(results).includes('98765'),false);
 const suspended=await updateMember(store,{id:member.id,version:member.version,status:'suspended'});
 assert.equal(validMemberSession(session,suspended),false);
 const enabled=await updateMember(store,{id:member.id,version:suspended.version,status:'invited'});
 assert.equal(validMemberSession(session,enabled),false);
 assert.equal((await store.read()).raw.includes(password),false);
});
test('duplicates, stale updates, expired/replaced invitations and weak passwords cannot activate',async()=>{
 config();const store=storeFixture();let token;
 const first=await inviteMember(store,input,async(_to,link)=>{token=link;},100000);
 await assert.rejects(inviteMember(store,input,async()=>{}),/EMAIL_EXISTS/);
 assert.throws(()=>invitedMember(token,[first.member],100000+86400001),/INVITE_INVALID/);
 await assert.rejects(activateMember(store,{token,password:'weak',confirmPassword:'weak'},100001),/PASSWORD_INVALID/);
 await assert.rejects(updateMember(store,{...input,id:first.member.id,version:0}),/VERSION_CONFLICT/);
 let replacement;
 await inviteMember(store,{id:first.member.id,version:first.member.version},async(_to,link)=>{replacement=link;},100002);
 const latest=await store.read();assert.throws(()=>invitedMember(token,latest.value.members,100003),/INVITE_INVALID/);
 assert.equal(invitedMember(replacement,latest.value.members,100003).id,first.member.id);
});
test('failed mail is recoverable and never reported sent; concurrent activation only succeeds once',async()=>{
 config();const store=storeFixture();let token;
 const failed=await inviteMember(store,input,async()=>{throw new Error('smtp failed');});
 assert.equal(failed.delivery,'failed');assert.equal(failed.member.invitation.sent,'failed');
 const resent=await inviteMember(store,{id:failed.member.id,version:failed.member.version},async(_to,link)=>{token=link;});
 assert.equal(resent.delivery,'sent');
 const results=await Promise.allSettled([activateMember(store,{token,password,confirmPassword:password}),activateMember(store,{token,password,confirmPassword:password})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
});
test('scope/role validation rejects escalation and changing verified email',async()=>{
 config();const store=storeFixture();
 for(const bad of [{...input,role:'owner'},{...input,propertyIds:['other-tenant']},{...input,email:'sweetfuntw@gmail.com'}]) await assert.rejects(inviteMember(store,bad,async()=>{}),/INVALID_INPUT/);
 const {member}=await inviteMember(store,input,async()=>{});
 await assert.rejects(updateMember(store,{...input,id:member.id,version:member.version,email:'attacker@example.test'}),/INVALID_INPUT/);
});
test('Gmail app password is encrypted and tamper-resistant',()=>{
 config();const secret=sealMailPassword('synthetic-secret');assert.equal(JSON.stringify(secret).includes('synthetic-secret'),false);assert.equal(openMailPassword(secret),'synthetic-secret');assert.throws(()=>openMailPassword({...secret,tag:Buffer.alloc(16).toString('base64')}));
});
