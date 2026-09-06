import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOwnerSession } from "../src/lib/calendar-owner-session.ts";
import { parseCredential, changeOwnerPassword, credentialMatches, credentialSessionValid } from "../src/lib/owner-password.ts";
const code="a".repeat(32), password="This is an isolated test passphrase!";
function fixture(){
 process.env.CALENDAR_OWNER_CODE_HASH=createHash("sha256").update(code).digest("hex"); process.env.CALENDAR_OWNER_SESSION_SECRET="b".repeat(64);
 let raw=JSON.stringify({schema:1,kind:"bootstrap",hash:process.env.CALENDAR_OWNER_CODE_HASH});
 return { read:async()=>parseCredential(raw),consumeAttempt:async()=>true,replace:async(expected,next)=>{if(raw!==expected)return false;raw=JSON.stringify(next);return true;}};
}
test("changing password revokes bootstrap code and previous sessions, with verified new session",async()=>{
 const store=fixture(), old=createOwnerSession();
 const session=await changeOwnerPassword(store,old,{password,confirmPassword:password}); const {value,raw}=await store.read();
 assert.equal(await credentialMatches(password,value),true); assert.equal(await credentialMatches(code,value),false);
 assert.equal(credentialSessionValid(old,value),false); assert.equal(credentialSessionValid(session,value),true);
 assert.equal(raw.includes(password),false); assert.equal(raw.includes(code),false);
});
test("unauthenticated, weak and mismatched changes do not mutate credentials",async()=>{
 const store=fixture(), original=(await store.read()).raw;
 await assert.rejects(changeOwnerPassword(store,undefined,{password,confirmPassword:password}),/UNAUTHORIZED/);
 await assert.rejects(changeOwnerPassword(store,createOwnerSession(),{password:"short",confirmPassword:"short"}),/12/);
 await assert.rejects(changeOwnerPassword(store,createOwnerSession(),{password,confirmPassword:"different"}),/不一致/);
 assert.equal((await store.read()).raw,original);
});
test("subsequent changes require current password and revoke previous custom-password sessions",async()=>{
 const store=fixture();const session=await changeOwnerPassword(store,createOwnerSession(),{password,confirmPassword:password});
 await assert.rejects(changeOwnerPassword(store,session,{password:password+"2",confirmPassword:password+"2",currentPassword:"wrong"}),/CURRENT_PASSWORD/);
 const next=await changeOwnerPassword(store,session,{password:password+"2",confirmPassword:password+"2",currentPassword:password}); const {value}=await store.read();
 assert.equal(await credentialMatches(password,value),false); assert.equal(credentialSessionValid(session,value),false); assert.equal(credentialSessionValid(next,value),true);
});
test("missing or malformed credential storage fails closed instead of restoring the old code",()=>{for(const raw of [null,"invalid",JSON.stringify({schema:1,kind:"password",hash:"bad"})])assert.throws(()=>parseCredential(raw),/UNAVAILABLE/);});
test("rate limit and concurrent updates reject changes",async()=>{
 const store=fixture();store.consumeAttempt=async()=>false;await assert.rejects(changeOwnerPassword(store,createOwnerSession(),{password,confirmPassword:password}),/RATE_LIMITED/);
 store.consumeAttempt=async()=>true;store.replace=async()=>false;await assert.rejects(changeOwnerPassword(store,createOwnerSession(),{password,confirmPassword:password}),/CONCURRENTLY/);
});
