import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import nodemailer from 'nodemailer';
import {NextRequest} from 'next/server';
import * as Session from '../src/app/api/calendar-session/route.ts';
import * as Members from '../src/app/api/workspace-members/route.ts';
import * as Mail from '../src/app/api/workspace-mail/route.ts';
import * as Invitation from '../src/app/api/workspace-invitation/route.ts';
import * as Recovery from '../src/app/api/workspace-recovery/route.ts';
import * as Appearance from '../src/app/api/calendar-appearance/route.ts';
import {provisionPhoneMembers} from '../src/lib/workspace-auth/provision-members.ts';
import {RedisWorkspaceStore} from '../src/lib/workspace-auth/store.ts';
import {OWNER_COOKIE} from '../src/lib/calendar-owner-session.ts';
import {MEMBER_COOKIE,createMemberSession} from '../src/lib/workspace-auth/session.ts';
import {createPasswordCredential} from '../src/lib/owner-password.ts';

test('complete API flow preserves owner password, sends invitation, activates, logs in and enforces separation',async t=>{
 process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('a'.repeat(32)).digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);
 process.env.KV_REST_API_URL='https://workspace.invalid';process.env.KV_REST_API_TOKEN='synthetic';
 const password='Owner synthetic test passphrase!',memberPassword='Member synthetic test passphrase!';
 const ownerRaw=JSON.stringify(await createPasswordCredential(password));
 const data=new Map([['sweetfun-os:owner-auth:v1:credential',ownerRaw]]);const mails=[];
 t.mock.method(globalThis,'fetch',async(_url,opt)=>{const c=JSON.parse(opt.body);let result=null;
  if(c[0]==='HSET'){data.set(c[1]+':'+c[2],c[3]);result=1;}
  if(c[0]==='HGET')result=data.get(c[1]+':'+c[2])??null;
  if(c[0]==='GET')result=data.get(c[1])??null;
  if(c[0]==='SET'){data.set(c[1],c[2]);result='OK';}
  if(c[0]==='EVAL'){
   if(c[1].includes('local old')){result=(data.get(c[3])??'')===c[4]?1:0;if(result)data.set(c[3],c[5]);}
   else result=1;
  }
  return Response.json({result});
 });
 t.mock.method(nodemailer,'createTransport',()=>({verify:async()=>true,sendMail:async mail=>{mails.push(mail);return {accepted:[mail.to]};},close:()=>{}}));
 const request=(path,method='GET',body,cookie,origin='https://calendar.test')=>new NextRequest(`https://calendar.test/api/${path}`,{method,headers:{host:'calendar.test',origin,...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await Members.GET(request('workspace-members'))).status,403);
 const login=await Session.POST(request('calendar-session','POST',{email:'sweetfuntw@gmail.com',code:password}));
 assert.equal(login.status,200);const ownerCookie=`${OWNER_COOKIE}=${login.cookies.get(OWNER_COOKIE).value}`;
 assert.equal((await (await Session.GET(request('calendar-session','GET',null,ownerCookie))).json()).membership.role,'owner');
 const memberInput={email:'new-staff@example.test',displayName:'Synthetic staff',role:'viewer_no_price',allProperties:false,propertyIds:['offland']};
 assert.equal((await Members.POST(request('workspace-members','POST',memberInput,ownerCookie))).status,503);
 assert.equal(mails.length,0);
 assert.equal((await Mail.PUT(request('workspace-mail','PUT',{appPassword:'abcd efgh ijkl mnop'},ownerCookie))).status,200);
 assert.equal(mails.length,1);assert.equal(mails[0].to,'sweetfuntw@gmail.com');
 const invited=await Members.POST(request('workspace-members','POST',memberInput,ownerCookie));assert.equal(invited.status,200);
 const invitationBody=await invited.json();assert.equal(invitationBody.delivery,'sent');assert.equal(mails.length,2);
 assert.equal(mails[1].from.address,'sweetfuntw@gmail.com');
 const token=mails[1].text.match(/\/activate#([^\s]+)/)[1];
 const inspect=await Invitation.POST(request('workspace-invitation','POST',{action:'inspect',token}));assert.equal((await inspect.json()).email,memberInput.email);
 const activated=await Invitation.POST(request('workspace-invitation','POST',{token,password:memberPassword,confirmPassword:memberPassword}));assert.equal(activated.status,200);
 assert.equal((await Invitation.POST(request('workspace-invitation','POST',{token,password:memberPassword,confirmPassword:memberPassword}))).status,400);
 const memberLogin=await Session.POST(request('calendar-session','POST',{email:memberInput.email,code:memberPassword}));assert.equal(memberLogin.status,200);
 const memberCookie=`${MEMBER_COOKIE}=${memberLogin.cookies.get(MEMBER_COOKIE).value}`;
 const sessionData=await (await Session.GET(request('calendar-session','GET',null,memberCookie))).json();
 assert.equal(sessionData.membership.role,'viewer_no_price');assert.deepEqual(sessionData.membership.propertyIds,['offland']);
 assert.equal((await Members.GET(request('workspace-members','GET',null,memberCookie))).status,403);
 assert.equal((await Mail.GET(request('workspace-mail','GET',null,memberCookie))).status,403);
 assert.equal((await Appearance.PUT(request('calendar-appearance','PUT',{palette:'jewel'},memberCookie))).status,200);
 assert.equal((await (await Appearance.GET(request('calendar-appearance','GET',null,ownerCookie))).json()).palette,'mist');
 const listed=await (await Members.GET(request('workspace-members','GET',null,ownerCookie))).json();
 assert.equal(JSON.stringify(listed).includes('credential'),false);assert.equal(JSON.stringify(listed).includes('hash'),false);
 const staff=listed.members.find(m=>m.email===memberInput.email);
 assert.equal((await Members.PATCH(request('workspace-members','PATCH',{id:staff.id,version:staff.version,status:'suspended'},ownerCookie))).status,200);
 assert.equal((await (await Session.GET(request('calendar-session','GET',null,memberCookie))).json()).authenticated,false);
 assert.equal((await Session.POST(request('calendar-session','POST',{email:memberInput.email,code:memberPassword}))).status,401);
 assert.equal(data.get('sweetfun-os:owner-auth:v1:credential'),ownerRaw);
 assert.equal((await Members.POST(request('workspace-members','POST',{...memberInput,email:'other@example.test'},ownerCookie,'https://evil.test'))).status,403);
 assert.equal(mails.length,2);
 const key='sweetfun-os:workspace-auth:v1:members';
 const base=JSON.parse(data.get(key));
 const manager={...base.members[0],id:'d'.repeat(32),email:'manager@example.test',role:'admin',status:'active',credential:await createPasswordCredential(memberPassword),version:1};
 const god={...manager,id:'e'.repeat(32),email:'operator@example.test',role:'god',allProperties:true,propertyIds:['sweetfun','offland']};
 data.set(key,JSON.stringify({...base,members:[...base.members,manager,god]}));
 const managerCookie=`${MEMBER_COOKIE}=${createMemberSession(manager)}`;
 const godCookie=`${MEMBER_COOKIE}=${createMemberSession(god)}`;
 assert.equal((await Members.GET(request('workspace-members','GET',null,managerCookie))).status,200);
 assert.equal((await Mail.GET(request('workspace-mail','GET',null,managerCookie))).status,200);
 assert.equal((await Recovery.GET(request('workspace-recovery','GET',null,managerCookie))).status,200);
 assert.equal((await Members.PATCH(request('workspace-members','PATCH',{id:manager.id,version:1,status:'suspended'},managerCookie))).status,403);
 assert.equal((await Members.PATCH(request('workspace-members','PATCH',{id:god.id,version:1,status:'suspended'},ownerCookie))).status,403);
 assert.equal((await Recovery.POST(request('workspace-recovery','POST',{id:god.id,version:1},managerCookie))).status,403);
 assert.equal((await Members.POST(request('workspace-members','POST',{...memberInput,email:'scope@example.test',propertyIds:['sweetfun']},managerCookie))).status,403);
 assert.equal((await Members.POST(request('workspace-members','POST',{...memberInput,email:'staff2@example.test'},managerCookie))).status,200);
 assert.equal((await Members.PATCH(request('workspace-members','PATCH',{id:manager.id,version:1,status:'suspended'},godCookie))).status,200);
 assert.equal((await Mail.GET(request('workspace-mail','GET',null,managerCookie))).status,403);
 assert.equal(data.get('sweetfun-os:owner-auth:v1:credential'),ownerRaw);

 const phoneAccounts=await provisionPhoneMembers(new RedisWorkspaceStore(),[{phone:'0911111111',password:memberPassword,displayName:'Phone fixture',role:'viewer_no_price',allProperties:false,propertyIds:['offland']}]);
 for(const phone of ['0911111111','+886911111111']){
  const response=await Session.POST(request('calendar-session','POST',{email:phone,code:memberPassword}));
  assert.equal(response.status,200);
  const cookie=`${MEMBER_COOKIE}=${response.cookies.get(MEMBER_COOKIE).value}`;
  const info=await(await Session.GET(request('calendar-session','GET',null,cookie))).json();
  assert.equal(info.membership.viewPrices,false);assert.deepEqual(info.membership.propertyIds,['offland']);
 }
 await assert.rejects(()=>provisionPhoneMembers(new RedisWorkspaceStore(),[{phone:'+886911111111',password:memberPassword,displayName:'Duplicate',role:'admin',allProperties:false,propertyIds:['sweetfun']}]),/PHONE_EXISTS/);
 assert.equal(phoneAccounts[0].mustResetPassword,false);

});
