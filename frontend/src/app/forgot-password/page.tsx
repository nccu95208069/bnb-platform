"use client";
import {useT} from "@/components/i18n/language-provider";
import Link from 'next/link';
export default function ForgotPassword(){
  const uiText = useT();
return <main className="flex min-h-dvh items-center justify-center bg-slate-50 p-5"><section className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6"><h1 className="text-xl font-semibold">{uiText("忘記密碼")}</h1><p className="text-sm leading-6">{uiText("請聯絡旅宿管理員，提供你登入用的 Email。管理員啟用你的密碼重設後，會將臨時密碼交給你。")}</p><p className="text-sm leading-6">{uiText("用原本的 Email 與臨時密碼登入，再設定自己的新密碼，就能進入日曆。這個流程不會寄送 Email 或簡訊。")}</p><Link href="/calendar-access" className="block rounded-lg bg-slate-900 p-3 text-center text-white">{uiText("已有臨時密碼，前往登入")}</Link></section></main>;}
