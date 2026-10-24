import type { Metadata } from "next";
import { SHEET_SHARE_EMAIL } from "@/lib/customer-intake/config";
import { sharedSheetEmail } from "@/lib/customer-workspaces/shared-sheet";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "分享 Google Sheet 給民宿 OS｜圖文教學",
  description: "依照四個步驟，把訂房試算表以檢視者權限分享給民宿 OS。",
};

const frame = "rounded-2xl border border-stone-200 bg-white p-5 shadow-sm";

export default function ShareGoogleSheetGuide() {
  const email = sharedSheetEmail() ?? SHEET_SHARE_EMAIL;
  return (
    <main className="min-h-dvh bg-[#f7f6ef] px-4 py-10 text-[#253b31] sm:px-8">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-semibold tracking-widest text-emerald-800">民宿 OS · Google Sheet 教學</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">讓系統讀取你的訂房試算表</h1>
        <p className="mt-4 max-w-2xl leading-7 text-stone-700">
          這裡分享的是 <strong>Google Sheet 試算表</strong>，不是 Google 日曆。只需將系統帳號設為「檢視者」，不用開放給所有知道連結的人，也不用改動原表。
        </p>
        <div className="mt-7 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-semibold text-emerald-900">要加入的系統帳號</p>
          <code className="mt-2 block break-all rounded-lg bg-white px-3 py-3 text-base font-semibold text-emerald-900 select-all">{email}</code>
          <p className="mt-2 text-sm text-stone-700">請複製完整地址；權限選「檢視者」。</p>
        </div>

        <ol className="mt-8 space-y-6">
          <li className={frame}>
            <div className="grid gap-5 md:grid-cols-[1fr_1.1fr] md:items-center">
              <div><p className="text-sm font-semibold text-emerald-800">步驟 1／4</p><h2 className="mt-1 text-xl font-semibold">開啟原試算表，點右上角「共用」</h2><p className="mt-2 leading-7 text-stone-700">先確認開的是你要匯入的那份訂房表。你需要擁有分享權限，才能加入系統帳號。</p></div>
              <figure className="rounded-xl border bg-stone-50 p-4">
                <div aria-hidden="true" className="rounded-lg border bg-white p-3 shadow-sm">
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold text-stone-600">訂房表 · Google Sheet</span><span className="rounded-full border-2 border-emerald-600 bg-emerald-100 px-4 py-1 font-semibold text-emerald-900">共用</span></div>
                  <div className="mt-4 grid grid-cols-3 gap-1 text-center text-xs text-stone-500"><span className="border bg-stone-50 p-1">日期</span><span className="border bg-stone-50 p-1">房間</span><span className="border bg-stone-50 p-1">訂單</span></div>
                </div>
                <figcaption className="mt-2 text-xs text-stone-500">示意畫面：找右上角的「共用」按鈕。</figcaption>
              </figure>
            </div>
          </li>
          <li className={frame}>
            <div className="grid gap-5 md:grid-cols-[1fr_1.1fr] md:items-center">
              <div><p className="text-sm font-semibold text-emerald-800">步驟 2／4</p><h2 className="mt-1 text-xl font-semibold">加入上方的系統帳號</h2><p className="mt-2 leading-7 text-stone-700">在「新增使用者或群組」欄貼上完整 Email，選取顯示的帳號。</p></div>
              <figure className="rounded-xl border bg-stone-50 p-4"><div aria-hidden="true" className="rounded-xl border bg-white p-4 shadow-sm"><div className="font-semibold">分享「訂房表」</div><div className="mt-3 rounded-lg border-2 border-emerald-600 p-2 text-xs text-stone-700">新增使用者或群組：{email}</div></div><figcaption className="mt-2 text-xs text-stone-500">示意畫面：把系統帳號加入指定使用者。</figcaption></figure>
            </div>
          </li>
          <li className={frame}>
            <div className="grid gap-5 md:grid-cols-[1fr_1.1fr] md:items-center">
              <div><p className="text-sm font-semibold text-emerald-800">步驟 3／4</p><h2 className="mt-1 text-xl font-semibold">權限選「檢視者」，再按「傳送」</h2><p className="mt-2 leading-7 text-stone-700">「一般存取權」維持「受限制」。不要選「編輯者」，也不用改成「知道連結的任何人」。</p></div>
              <figure className="rounded-xl border bg-stone-50 p-4"><div aria-hidden="true" className="space-y-2 rounded-xl border bg-white p-4 shadow-sm"><div className="rounded-lg border-2 border-emerald-600 bg-emerald-50 p-2 font-semibold">權限：檢視者 ✓</div><div className="rounded-lg border p-2">一般存取權：受限制 ✓</div><div className="ml-auto w-fit rounded-lg bg-emerald-800 px-4 py-1 text-white">傳送</div></div><figcaption className="mt-2 text-xs text-stone-500">示意畫面：只授予指定帳號的唯讀權限。</figcaption></figure>
            </div>
          </li>
          <li className={frame}>
            <div className="grid gap-5 md:grid-cols-[1fr_1.1fr] md:items-center">
              <div><p className="text-sm font-semibold text-emerald-800">步驟 4／4</p><h2 className="mt-1 text-xl font-semibold">複製試算表網址，回原頁檢查</h2><p className="mt-2 leading-7 text-stone-700">從瀏覽器網址列複製以 <code>docs.google.com/spreadsheets/d/</code> 開頭的連結。回到民宿 OS 原分頁貼上，按「檢查分享權限」或「讀取分頁」。看到可讀取後，再核對欄位與預覽訂單。</p></div>
              <figure className="rounded-xl border bg-stone-50 p-4"><div aria-hidden="true" className="space-y-3 rounded-xl border bg-white p-4 shadow-sm"><div className="rounded-lg border p-2 text-xs text-stone-600">https://docs.google.com/spreadsheets/d/…</div><div className="flex items-center gap-2"><span className="rounded-lg border p-2 text-xs">貼上連結</span><span aria-hidden="true">→</span><span className="rounded-lg bg-emerald-800 p-2 text-xs text-white">檢查分享權限</span></div></div><figcaption className="mt-2 text-xs text-stone-500">示意畫面：檢查成功後還會有欄位對應和匯入預覽。</figcaption></figure>
            </div>
          </li>
        </ol>

        <section className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="font-semibold">如果系統仍讀不到</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 leading-7 text-stone-700"><li>確認分享的是同一份試算表，且系統帳號拼寫完整。</li><li>確認權限是「檢視者」，並已按「傳送」。</li><li>公司或學校帳號可能禁止對外分享；請向管理員確認，或在匯入頁聯絡專人。</li></ul>
        </section>
        <p className="mt-6 text-sm text-stone-600">Google 介面可能更新；以上圖片是操作示意。<a className="ml-1 underline" href="https://support.google.com/drive/answer/2494822?hl=zh-Hant" target="_blank" rel="noopener noreferrer">查看 Google 官方分享說明</a></p>
      </div>
    </main>
  );
}
