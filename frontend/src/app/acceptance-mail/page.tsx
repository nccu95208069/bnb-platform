import { notFound } from "next/navigation";
import { customerOrigin } from "@/lib/customer-workspaces/site-url";
import { acceptanceGmailReady } from "@/lib/workspace-auth/acceptance-gmail-oauth";
import { mailStatus } from "@/lib/workspace-auth/mail";

export const dynamic = "force-dynamic";

export default async function AcceptanceMailPage({ searchParams }: {
  searchParams: Promise<{ result?: string }>;
}) {
  if (process.env.CUSTOMER_ISOLATED_ACCEPTANCE !== "true") notFound();
  const status = await mailStatus();
  const ready = acceptanceGmailReady();
  const callback = `${customerOrigin()}/api/acceptance-mail/google/callback`;
  const result = (await searchParams).result;
  return (
    <main className="mx-auto max-w-xl space-y-5 p-6">
      <h1 className="text-2xl font-semibold">測試寄信授權</h1>
      {result === "denied" && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-900">你尚未授權寄信。確認使用下方測試信箱後，可以重新操作。</p>}
      {result === "failed" && <p role="alert" className="rounded-lg bg-amber-50 p-4 text-amber-900">授權或測試寄信未完成；目前仍無法寄信。請核對 Google 設定後重試。</p>}
      <p>候選寄件信箱：<strong>{status.sender ?? "尚未指定"}</strong></p>
      {status.configured ? (
        <p role="status" className="rounded-lg bg-emerald-50 p-4 text-emerald-900">
          Google 授權已完成，測試信已送往此信箱。請在收件匣確認主旨「Sweetfun OS 寄信已啟用」。
        </p>
      ) : ready ? (
        <>
          <p>請由此信箱本人按下按鈕，在 Google 官方畫面確認帳號與「代您寄送電子郵件」權限。完成後系統會核對寄件帳號，並寄一封測試信到同一信箱。</p>
          <form action="/api/acceptance-mail/google/start" method="post">
            <button className="rounded-lg bg-slate-900 px-5 py-3 text-white">使用 Google 授權測試寄信</button>
          </form>
        </>
      ) : (
        <p className="rounded-lg bg-amber-50 p-4 text-amber-900">
          授權入口尚未開放。請先在獨立測試 Google Cloud 專案完成 OAuth 設定；此頁不收取 Gmail 密碼或授權碼。
        </p>
      )}
      <p className="text-sm text-slate-600">OAuth 回呼網址：<span className="break-all">{callback}</span></p>
      <p className="text-sm text-slate-600">此候選站仍受 Vercel 登入保護。網站接單、保留房間及訂單通知維持關閉。</p>
    </main>
  );
}
