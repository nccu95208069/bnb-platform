"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="p-8">
      <h1>訂單暫時讀取失敗</h1>
      <p className="my-3">請重新讀取，原有訂單不受影響。</p>
      <button
        className="rounded-xl bg-teal-800 px-5 py-3 text-white"
        onClick={reset}
      >
        重試
      </button>
    </main>
  );
}
