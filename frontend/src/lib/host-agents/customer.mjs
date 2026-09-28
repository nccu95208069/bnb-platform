import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
export const READ_ACTIONS=['oa_list_conversations','oa_read_conversation'];
export const WRITE_ACTIONS=['oa_reply','oa_set_tag','oa_set_name'];
export const OA_ACTIONS=[...READ_ACTIONS,...WRITE_ACTIONS];
export function customerCrypto(secret){
 if(typeof secret!=='string'||secret.length<32)throw Error('customer_secret_unavailable');
 const key=createHash('sha256').update('sweetfun-customer-v1:'+secret).digest();
 return {seal(value,scope){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(scope));const data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return [iv,c.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');},open(value,scope){const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64url'));const c=createDecipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from(scope));c.setAuthTag(tag);return JSON.parse(Buffer.concat([c.update(data),c.final()]).toString('utf8'));}};
}
function text(v,max,multiline=false){if(typeof v!=='string'||!v.trim()||v.length>max||(multiline?/[\u0000-\u0009\u000b-\u001f\u007f]/:/[\u0000-\u001f\u007f]/).test(v))throw Error('invalid_customer_input');return v;}

export function customerPayload(action,input={}){
 if(!OA_ACTIONS.includes(action))throw Error('invalid_customer_action');
 const p={};
 if(action!=='oa_list_conversations')p.display_name=text(input.display_name,100);
 if(WRITE_ACTIONS.includes(action))p.conversation_ref=text(input.conversation_ref,128);
 if(action==='oa_reply')p.text=text(input.text,1000,true);
 if(action==='oa_set_tag')p.tag=text(input.tag,20);
 if(action==='oa_set_name')p.new_name=text(input.new_name,20);
 if(Object.keys(input).some(k=>!Object.hasOwn(p,k)))throw Error('invalid_customer_input');
 return p;
}
// Explicit projection: never store screenshots, complete accessibility trees or unknown host fields.
export function customerOutput(action,value){
 if(!value||typeof value!=='object')throw Error('invalid_customer_result');
 const stamp=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?v:null;
 const limitations=Array.isArray(value.limitations)?value.limitations.slice(0,5).filter(x=>typeof x==='string').map(x=>x.slice(0,300)):[];
 if(action==='oa_list_conversations')return {conversations:(Array.isArray(value.conversations)?value.conversations:[]).slice(0,50).map(c=>({display_name:text(c.display_name,100),...(typeof c.revision==='string'&&/^[a-f0-9]{64}$/.test(c.revision)?{revision:c.revision}:{}),...(typeof c.preview==='string'?{preview:c.preview.slice(0,500)}:{})})),observed_at:stamp(value.observed_at),limitations};
 if(action==='oa_read_conversation')return {conversation_ref:text(value.conversation_ref,128),display_name:text(value.display_name,100),messages:(Array.isArray(value.messages)?value.messages:[]).slice(-60).map(m=>({text:typeof m.text==='string'?m.text.slice(0,4000):'',direction:['incoming','outgoing','unknown'].includes(m.direction)?m.direction:'unknown'})),tags:(Array.isArray(value.tags)?value.tags:[]).filter(x=>typeof x==='string').slice(0,30).map(x=>x.slice(0,40)),observed_at:stamp(value.observed_at),expires_at:stamp(value.expires_at),limitations};
 return {verified:value.verified===true,...(value.conversation?{conversation:customerOutput('oa_read_conversation',value.conversation)}:{}),limitations};
}
