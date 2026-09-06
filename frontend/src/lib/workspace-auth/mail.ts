import nodemailer from 'nodemailer';
import { gmailAuthorization, sendGmail, type GmailAuthorization } from './gmail.ts';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {ADMIN_EMAIL,validEmail} from './types.ts';
import {redisCommand,workspacePrefix} from './store.ts';
function encryptionKey() {
  const secret=process.env.CALENDAR_OWNER_SESSION_SECRET;
  if(!secret||! /^[a-f0-9]{64}$/.test(secret))throw new Error('MAIL_NOT_CONFIGURED');
  return createHash('sha256').update(`sweetfun-mail-config:${secret}`).digest();
}
export function sealMailPassword(password:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const data=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);
  return {iv:iv.toString('base64'),data:data.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
export function openMailPassword(secret:ReturnType<typeof sealMailPassword>) {
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(secret.iv,'base64'));decipher.setAuthTag(Buffer.from(secret.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.data,'base64')),decipher.final()]).toString('utf8');
}
async function storedMail(){const raw=await redisCommand(['GET',`${workspacePrefix()}:mail`]);return typeof raw==='string'?JSON.parse(raw):null;}
export async function mailStatus(){const value=await storedMail();return {configured:Boolean(value?.secret),sender:ADMIN_EMAIL,verifiedAt:value?.verifiedAt??null,method:value?.secret?(value.method??'app_password'):null};}
function transport(password:string) {return nodemailer.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:ADMIN_EMAIL,pass:password},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,tls:{minVersion:'TLSv1.2'}});}
export async function configureMail(input:unknown) {
  const password=typeof input==='string'?input.replace(/\s/g,''):'';
  if(!/^[a-zA-Z]{16}$/.test(password))throw new Error('INVALID_INPUT');
  const smtp=transport(password);
  try {
    await smtp.verify();
    const result=await smtp.sendMail({from:{name:'Sweetfun OS',address:ADMIN_EMAIL},to:ADMIN_EMAIL,subject:'Sweetfun OS 寄信設定測試',text:'這是你剛剛在 Sweetfun OS 啟用 Gmail 寄信時送出的測試信。之後成員邀請信會由此信箱寄出。本信不含密碼或登入連結。'});
    if(!result.accepted?.length)throw new Error('MAIL_FAILED');
  } catch {throw new Error('MAIL_FAILED');} finally {smtp.close();}
  const secret=sealMailPassword(password),verifiedAt=new Date().toISOString();
  await redisCommand(['SET',`${workspacePrefix()}:mail`,JSON.stringify({secret,verifiedAt})]);
  const check=await storedMail();
  if(check?.verifiedAt!==verifiedAt||openMailPassword(check.secret)!==password)throw new Error('WRITE_UNCONFIRMED');
  return {configured:true,sender:ADMIN_EMAIL,verifiedAt};
}
// Operator setup only: no public endpoint accepts existing OAuth credentials.
export async function configureGmailOAuth(input: GmailAuthorization) {
  const config = gmailAuthorization(input);
  const messageId = await sendGmail(config, ADMIN_EMAIL, 'Sweetfun OS 寄信已啟用', 'Sweetfun OS 的寄信功能已接通。這封信由 sweetfuntw@gmail.com 寄出。現在可以在權限管理新增成員，對方將收到設定密碼的邀請信。原抓單服務與你的網站登入密碼均未變更。');
  const plaintext = JSON.stringify(config), secret = sealMailPassword(plaintext), verifiedAt = new Date().toISOString();
  await redisCommand(['SET', `${workspacePrefix()}:mail`, JSON.stringify({ method: 'gmail_oauth', secret, verifiedAt })]);
  const check = await storedMail();
  if (check?.method !== 'gmail_oauth' || check.verifiedAt !== verifiedAt || openMailPassword(check.secret) !== plaintext) throw new Error('WRITE_UNCONFIRMED');
  return { configured: true, sender: ADMIN_EMAIL, method: 'gmail_oauth', verifiedAt, messageId };
}
export async function sendInvitation(to:string,token:string) {
  if(!validEmail(to))throw new Error('INVALID_INPUT');
  const value=await storedMail();if(!value?.secret)throw new Error('MAIL_NOT_CONFIGURED');
  // Fixed trusted origin; never derive activation links from a Host header.
  const url=`https://sweetfun-os.vercel.app/activate#${token}`;
  const message = {from:{name:'Sweetfun OS',address:ADMIN_EMAIL},to,subject:'Sweetfun OS｜設定你的帳號密碼',text:`管理者邀請你使用 Sweetfun OS。\n\n請於 24 小時內開啟以下連結，自行設定密碼：\n${url}\n\n設定完成後，以本信箱及你設定的密碼登入：\nhttps://sweetfun-os.vercel.app/calendar-access\n\n本連結只能使用一次；若你未預期收到邀請，可忽略本信。管理者不會知道你設定的密碼。`};
  if (value.method === 'gmail_oauth') {
    await sendGmail(gmailAuthorization(JSON.parse(openMailPassword(value.secret))), to, message.subject, message.text);
    return;
  }
  const smtp=transport(openMailPassword(value.secret));
  try {
    const result=await smtp.sendMail(message);
    if(!result.accepted?.length)throw new Error('MAIL_FAILED');
  } finally {smtp.close();}
}
