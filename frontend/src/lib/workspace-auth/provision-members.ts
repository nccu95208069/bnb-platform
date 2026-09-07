// Explicit server-side provisioning for administrator-supplied phone accounts.
import {randomBytes} from 'node:crypto';
import {createPasswordCredential} from '../owner-password.ts';
import {normalizedPhone,nextWorkspace,type Member} from './types.ts';
import {memberInput} from './members.ts';
import type {WorkspaceStore} from './store.ts';
export async function provisionPhoneMembers(store:WorkspaceStore, inputs:Record<string,unknown>[]) {
 const state=await store.read();
 const added:Member[]=[];
 for(const input of inputs){
  const values=memberInput({...input,email:''});
  if(!values.phone||state.value.members.some(m=>normalizedPhone(m.phone)===values.phone)||added.some(m=>m.phone===values.phone))throw new Error('PHONE_EXISTS');
  added.push({...values,id:randomBytes(16).toString('hex'),status:'active',credential:await createPasswordCredential(input.password as string),invitation:null,version:1,invitedAt:new Date().toISOString(),acceptedAt:new Date().toISOString(),lastActiveAt:null,mustResetPassword:false});
 }
 if(state.value.members.length+added.length>100)throw new Error('INVALID_INPUT');
 await store.replace(state.raw,nextWorkspace(state.value,[...state.value.members,...added],'phone_members_provisioned',added.map(m=>m.id).join(','),'system-provisioning'));
 const readback=await store.read();
 for(const member of added){if(JSON.stringify(readback.value.members.find(m=>m.id===member.id))!==JSON.stringify(member))throw new Error('WRITE_UNCONFIRMED');}
 return added;
}
