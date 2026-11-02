import { NextRequest, NextResponse } from 'next/server';
import { ownerAccessConfigured } from '@/lib/calendar-owner-session';
import { inspectEmailRecovery, consumeEmailRecovery, requestEmailRecovery } from '@/lib/workspace-auth/email-recovery';
import { authFailure, inputBody, privateHeaders, sameOrigin } from '@/lib/workspace-auth/http';
import { mailStatus, sendCustomerLifecycleMail } from '@/lib/workspace-auth/mail';
import { RedisWorkspaceStore } from '@/lib/workspace-auth/store';
import { ADMIN_EMAIL, normalizedEmail, validEmail } from '@/lib/workspace-auth/types';
import { RedisOwnerCredentialStore } from '@/lib/owner-password';
import { consumeOwnerEmailRecovery, inspectOwnerEmailRecovery, requestOwnerEmailRecovery } from '@/lib/workspace-auth/owner-email-recovery';

function failure(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  if (code === 'RECOVERY_INVALID') return NextResponse.json(
    { detail: '重設連結已失效或已使用，請重新申請。' }, { status: 400, headers: privateHeaders });
  if (code === 'PASSWORD_INVALID') return NextResponse.json(
    { detail: '請使用不易猜測的 12～128 個字元，並確認兩次輸入一致。' }, { status: 400, headers: privateHeaders });
  return authFailure(error);
}

const genericRequestDetail = '如果此信箱有已啟用的既有日曆帳號，重設連結會寄到信箱。請也檢查垃圾郵件。';
const requestResponseFloorMs = 600;

export async function handleRecovery(request: NextRequest, schedule: (task: () => Promise<void>) => void) {
  try {
    sameOrigin(request);
    if (!ownerAccessConfigured()) throw new Error('MAIL_NOT_CONFIGURED');
    const input = await inputBody(request);
    const store = new RedisWorkspaceStore();
    if (input.action === 'request') {
      const started = Date.now();
      const email = normalizedEmail(input.email);
      if (!validEmail(email)) throw new Error('INVALID_INPUT');
      await store.limit('calendar-email-recovery-global', 100, 3600);
      await store.limit(`calendar-email-recovery:${email}`, 3, 3600);
      if (!(await mailStatus()).configured) throw new Error('MAIL_NOT_CONFIGURED');
      try {
        const send = async (to: string, url: string) => {
          schedule(async () => {
            try {
              await sendCustomerLifecycleMail(to, 'Sweetfun OS｜重設既有日曆密碼',
                `你剛剛要求重設 Sweetfun OS 既有兩館日曆的密碼。請於 30 分鐘內開啟以下一次性連結，自行設定新密碼：\n${url}\n\n如果不是你提出的要求，請忽略本信；原密碼仍可使用。`);
            } catch {
              console.warn('calendar_password_recovery_mail_failed');
            }
          });
        };
        const outcome = email === ADMIN_EMAIL
          ? await requestOwnerEmailRecovery(new RedisOwnerCredentialStore(), send, Date.now(), request.nextUrl.origin)
          : await requestEmailRecovery(store, email, send, Date.now(), request.nextUrl.origin);
        if (outcome.eligible && !outcome.delivered) console.warn('calendar_password_recovery_schedule_failed');
      } catch {
        // Keep account existence private even when an eligible account changes concurrently.
        console.warn('calendar_password_recovery_request_failed');
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, requestResponseFloorMs - (Date.now() - started))));
      return NextResponse.json({ detail: genericRequestDetail }, { headers: privateHeaders });
    }
    if (input.action === 'inspect') {
      await store.limit('calendar-email-recovery-inspect', 120, 900);
      return NextResponse.json(typeof input.token === 'string' && input.token.startsWith('owner.')
        ? await inspectOwnerEmailRecovery(new RedisOwnerCredentialStore(), input.token)
        : await inspectEmailRecovery(store, input.token), { headers: privateHeaders });
    }
    if (input.action === 'consume') {
      await store.limit('calendar-email-recovery-consume', 80, 900);
      const result = typeof input.token === 'string' && input.token.startsWith('owner.')
        ? await consumeOwnerEmailRecovery(new RedisOwnerCredentialStore(), input.token, input.password, input.confirmPassword)
        : await consumeEmailRecovery(store, input.token, input.password, input.confirmPassword);
      try {
        await sendCustomerLifecycleMail(result.email, 'Sweetfun OS｜既有日曆密碼已更新',
          '你的 Sweetfun OS 既有兩館日曆密碼已更新，舊登入狀態已失效。若這不是你本人操作，請立即聯絡旅宿管理員。');
      } catch {
        // The password is already changed; a notification failure must not suggest a retry.
        console.warn('calendar_password_recovery_notice_failed');
      }
      return NextResponse.json({ reset: true }, { headers: privateHeaders });
    }
    throw new Error('INVALID_INPUT');
  } catch (error) {
    return failure(error);
  }
}
