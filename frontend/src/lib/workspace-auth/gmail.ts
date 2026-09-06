import { randomUUID } from 'node:crypto';
import { ADMIN_EMAIL, validEmail } from './types.ts';

export type GmailAuthorization = { clientId: string; clientSecret: string; refreshToken: string };
export function gmailAuthorization(input: unknown): GmailAuthorization {
  const value = input as Partial<GmailAuthorization> | null;
  if (!value || ![value.clientId, value.clientSecret, value.refreshToken].every(v => typeof v === 'string' && v.length > 0 && v.length < 4096)) throw new Error('INVALID_INPUT');
  return { clientId: value.clientId!, clientSecret: value.clientSecret!, refreshToken: value.refreshToken! };
}
const SEND_SCOPES = new Set(['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']);
async function googleJson(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('MAIL_FAILED');
    return await response.json();
  } catch { throw new Error('MAIL_FAILED'); }
}
export async function gmailAccess(input: GmailAuthorization): Promise<string> {
  const config = gmailAuthorization(input);
  const result = await googleJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
  });
  if (typeof result.access_token !== 'string' || (typeof result.scope === 'string' && !result.scope.split(' ').some((s: string) => SEND_SCOPES.has(s)))) throw new Error('MAIL_FAILED');
  const profile = await googleJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${result.access_token}` } });
  if (profile.emailAddress?.toLowerCase() !== ADMIN_EMAIL) throw new Error('MAIL_SENDER_MISMATCH');
  return result.access_token;
}
export function gmailMessage(to: string, subject: string, text: string) {
  if (!validEmail(to) || /[\r\n]/.test(subject)) throw new Error('INVALID_INPUT');
  const encodedSubject = Buffer.from(subject).toString('base64');
  const encodedBody = Buffer.from(text).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return Buffer.from([
    `From: Sweetfun OS <${ADMIN_EMAIL}>`, `To: ${to}`,
    `Subject: =?UTF-8?B?${encodedSubject}?=`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@sweetfun-os.vercel.app>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', encodedBody,
  ].join('\r\n')).toString('base64url');
}
export async function sendGmail(input: GmailAuthorization, to: string, subject: string, text: string) {
  const raw = gmailMessage(to, subject, text);
  const token = await gmailAccess(input);
  const result = await googleJson('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }),
  });
  if (typeof result.id !== 'string' || !result.id) throw new Error('MAIL_FAILED');
  return result.id as string;
}
