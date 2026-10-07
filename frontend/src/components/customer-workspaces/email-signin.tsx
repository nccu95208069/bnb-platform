"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { button } from "./client";
import { useCommand } from "./use-command";
export function EmailSignIn() {
  const router = useRouter(),
    token = useRef(""),
    loaded = useRef(false),
    command = useCommand("/api/customer-login");
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    token.current = window.location.hash.slice(1);
    window.history.replaceState(null, "", "/signin");
  }, []);
  async function signIn() {
    if (!token.current) {
      command.setError(
        "沒有可用的登入連結。請重新開啟信件中的完整連結，或回登入頁申請新連結。",
      );
      return;
    }
    const result = await command.execute<{ url: string }>({
      action: "consume",
      token: token.current,
    });
    if (result) router.replace(result.data.url);
  }
  return (
    <main className="min-h-dvh bg-stone-50 px-5 py-12 text-slate-900">
      <section className="mx-auto max-w-lg space-y-5 rounded-2xl border bg-white p-6">
        <h1 className="text-2xl font-semibold">確認登入旅宿工作區</h1>
        <p className="leading-7 text-slate-600">
          使用剛才申請連結的同一個瀏覽器繼續，不需設定密碼。若有日曆預覽，登入後會返回原進度，由你確認保存。
        </p>
        <button
          className={button}
          disabled={command.busy}
          onClick={() => void signIn()}
        >
          {command.busy
            ? "正在驗證…"
            : command.uncertain
              ? "重試並確認登入結果"
              : "確認登入並繼續"}
        </button>
        {command.error && (
          <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">
            {command.error}
          </p>
        )}
        <a className="block text-sm text-teal-800 underline" href="/start">
          回登入頁
        </a>
        <a
          className="block text-sm text-teal-800 underline"
          href="/join/calendar"
        >
          返回日曆預覽
        </a>
      </section>
    </main>
  );
}
