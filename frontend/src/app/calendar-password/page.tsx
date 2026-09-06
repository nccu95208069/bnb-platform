"use client";
import { useEffect, useState } from "react";
export default function CalendarPasswordPage() {
  const [state, setState] = useState<{authenticated:boolean;has_custom_password:boolean}|null>(null);
  const [currentPassword,setCurrentPassword]=useState("");
  const [password,setPassword]=useState("");
  const [confirmPassword,setConfirmPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [saved,setSaved]=useState(false);
  useEffect(()=>{let active=true; fetch("/api/calendar-session",{cache:"no-store"}).then(async r=>{if(!r.ok)throw new Error("無法確認登入，請重新整理。");return r.json();}).then(data=>{if(active)setState(data);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[]);
  async function save(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError("");
    if(password!==confirmPassword){setError("兩次新密碼不一致。");return;}
    setBusy(true);
    try{
      const response=await fetch("/api/calendar-session",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword,password,confirmPassword})});
      if(!response.ok)throw new Error((await response.json()).detail||"密碼未能儲存，請稍後再試。");
      setCurrentPassword("");setPassword("");setConfirmPassword("");setSaved(true);
    }catch(e){setError(e instanceof Error?e.message:"設定失敗，請稍後再試。");}finally{setBusy(false);}
  }
  return <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-5 py-8"><section className="w-full max-w-sm space-y-5 rounded-2xl border bg-white p-6 shadow-sm">
    <div><p className="text-sm text-slate-500">Sweetfun OS</p><h1 className="mt-2 text-xl font-semibold">變更私人密碼</h1></div>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    {saved?<><p role="status">私人密碼已儲存。舊登入碼與其他裝置的登入已失效；這台裝置保持登入。</p><a href="/calendar" className="block rounded-lg bg-slate-900 px-4 py-3 text-center text-white">返回日曆</a></>:!state?<p className="text-sm text-slate-500">確認登入中…</p>:!state.authenticated?<><p>請先登入私人日曆，再設定密碼。</p><a href="/calendar-access" className="block text-sm underline">前往登入</a></>:<form onSubmit={save} className="space-y-4">
      {state.has_custom_password&&<label className="block text-sm font-medium">目前密碼<input type="password" autoComplete="current-password" required value={currentPassword} onChange={e=>setCurrentPassword(e.target.value)} className="mt-2 block w-full rounded-lg border px-3 py-2.5"/></label>}
      <label className="block text-sm font-medium">新密碼<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={e=>setPassword(e.target.value)} className="mt-2 block w-full rounded-lg border px-3 py-2.5"/></label>
      <label className="block text-sm font-medium">再次輸入新密碼<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} className="mt-2 block w-full rounded-lg border px-3 py-2.5"/></label>
      <p className="text-xs text-slate-500">至少 12 個字元，可用較長的短句。儲存後請改用新密碼登入，舊私人入口中的登入碼會失效。</p>
      <button disabled={busy} className="w-full rounded-lg bg-slate-900 px-4 py-3 text-white disabled:opacity-50">{busy?"儲存中…":"儲存私人密碼"}</button>
      <a href="/calendar" className="block text-center text-sm underline">返回日曆</a>
    </form>}
  </section></main>;
}
