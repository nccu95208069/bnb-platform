"use client";
import { useEffect, useState } from "react";
import { api, button, field, secondary } from "./client";
type Profile = {
  email: string;
  workspaces: { id: string; slug: string; name: string }[];
};
export function Onboarding({
  allowRegistration = false,
}: {
  allowRegistration?: boolean;
}) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [loading, setLoading] = useState(true);
  const [mode, setMode] = useState("login"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState(1),
    [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [kind, setKind] = useState("rooms"),
    [rooms, setRooms] = useState("");
  const [key, setKey] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  useEffect(() => {
    api<Profile>("/api/customer-session")
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
    setKey(crypto.randomUUID());
  }, []);
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (mode === "recover") {
        const result = await api<{ detail: string }>(
          "/api/customer-account",
          "POST",
          { action: "recover", email: form.get("email") },
        );
        setNotice(result.detail);
        return;
      }
      await api("/api/customer-session", "POST", {
        mode,
        email: form.get("email"),
        password: form.get("password"),
        confirmPassword: form.get("confirmPassword"),
      });
      const next = await api<Profile>("/api/customer-session");
      setProfile(next);
      const destination = new URLSearchParams(location.search).get("next");
      if (
        destination &&
        /^\/w\/[a-z0-9-]{3,48}\/(calendar|availability|finance|settings|import)$/.test(
          destination,
        )
      )
        location.assign(destination);
      else if (next.workspaces.length === 1)
        location.assign(`/w/${next.workspaces[0].slug}/calendar`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ slug: string }>(
        "/api/customer-workspaces",
        "POST",
        {
          name,
          slug,
          kind,
          rooms:
            kind === "villa" && !rooms.trim()
              ? ["整棟"]
              : rooms
                  .split(/[\n,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
          requestKey: key,
        },
      );
      location.assign(`/w/${result.slug}/calendar`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 px-5 py-12 text-slate-800">
      <div className="mx-auto max-w-xl">
        <a
          href="/join"
          className="mb-5 inline-block text-sm text-teal-800 underline"
        >
          了解服務／專人諮詢
        </a>
        <p className="text-sm font-semibold tracking-widest text-teal-800">
          旅宿工作區
        </p>
        <h1 className="my-4 text-3xl font-semibold">從自己的房況日曆開始</h1>
        <p className="mb-8 text-slate-600">
          已完成申請與信箱確認的客戶，可在這裡登入。
        </p>
        {loading ? (
          <p>讀取中…</p>
        ) : !profile ? (
          <form
            onSubmit={signIn}
            className="space-y-5 rounded-2xl border bg-white p-6"
          >
            <div className="flex gap-2">
              {[
                ["login", "登入"],
                ...(allowRegistration ? [["register", "建立帳號"]] : []),
                ["recover", "忘記密碼"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={mode === value ? button : secondary}
                  onClick={() => {
                    setMode(value);
                    setNotice("");
                    setError("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="block">
              Email
              <input
                className={field}
                name="email"
                type="email"
                autoComplete="username"
                required
              />
            </label>
            {notice && (
              <p role="status" className="rounded-xl bg-teal-50 p-4">
                {notice}
              </p>
            )}
            {mode !== "recover" && (
              <label className="block">
                密碼
                <input
                  className={field}
                  name="password"
                  type="password"
                  autoComplete={
                    mode === "register" ? "new-password" : "current-password"
                  }
                  minLength={12}
                  maxLength={128}
                  required
                />
              </label>
            )}
            {mode === "register" && (
              <label className="block">
                再次輸入密碼
                <input
                  className={field}
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
              </label>
            )}
            <p className="text-sm text-slate-500">
              新客戶請先
              <a className="underline" href="/join">
                填寫加入申請
              </a>
              ，再使用確認信中的連結設定帳號。
            </p>
            <button className={button} disabled={busy}>
              {busy
                ? "處理中…"
                : mode === "register"
                  ? "建立帳號並繼續"
                  : mode === "recover"
                    ? "寄送重設密碼連結"
                    : "登入並繼續"}
            </button>
          </form>
        ) : (
          <section className="space-y-6 rounded-2xl border bg-white p-6">
            {profile.workspaces.length > 0 && (
              <div>
                <h2 className="font-semibold">你的旅宿</h2>
                {profile.workspaces.map((w) => (
                  <a
                    key={w.id}
                    className="mt-2 block rounded-xl bg-teal-50 p-3 text-teal-900"
                    href={`/w/${w.slug}/calendar`}
                  >
                    {w.name} →
                  </a>
                ))}
              </div>
            )}
            <p className="text-sm text-slate-500">
              {profile.email} · 設定 {step} / 3
            </p>
            {step === 1 && (
              <>
                <label className="block">
                  旅宿名稱
                  <input
                    className={field}
                    value={name}
                    maxLength={80}
                    onChange={(e) => {
                      setName(e.target.value);
                      if (!slugEdited)
                        setSlug(
                          e.target.value
                            .toLowerCase()
                            .replace(/[^a-z0-9-]/g, "")
                            .slice(0, 48),
                        );
                    }}
                  />
                </label>
                <label className="block">
                  網址代稱
                  <input
                    className={field}
                    placeholder="happyhouse-yilan"
                    value={slug}
                    onChange={(e) => {
                      setSlugEdited(true);
                      setSlug(e.target.value.toLowerCase());
                    }}
                    pattern="[a-z0-9][a-z0-9-]{2,47}"
                  />
                  <span className="mt-2 block text-sm text-slate-500">
                    /w/{slug || "你的旅宿"}/calendar · 3～48
                    個英文字母、數字或連字號
                  </span>
                </label>
                <fieldset>
                  <legend className="mb-2">經營型態</legend>
                  <div className="flex flex-wrap gap-2">
                    {[
                      ["villa", "包棟"],
                      ["rooms", "單房"],
                      ["mixed", "兩者皆有"],
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        aria-pressed={kind === value}
                        className={kind === value ? button : secondary}
                        onClick={() => setKind(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <button
                  className={button}
                  disabled={
                    !name.trim() || !/^[a-z0-9][a-z0-9-]{2,47}$/.test(slug)
                  }
                  onClick={() => setStep(2)}
                >
                  下一步：房間
                </button>
              </>
            )}
            {step === 2 && (
              <>
                <label className="block">
                  {kind === "villa"
                    ? "整棟內的房間（可略過）"
                    : "房號或房間名稱"}
                  <textarea
                    className={field}
                    rows={5}
                    placeholder={"101\n102\n201"}
                    value={rooms}
                    onChange={(e) => setRooms(e.target.value)}
                  />
                </label>
                <p className="text-sm text-slate-500">
                  每行一間，也可以用逗號分隔。
                  {kind !== "rooms" && "包棟會占用上面全部房間。"}
                </p>
                <div className="flex gap-3">
                  <button className={secondary} onClick={() => setStep(1)}>
                    上一步
                  </button>
                  <button
                    className={button}
                    disabled={kind !== "villa" && !rooms.trim()}
                    onClick={() => setStep(3)}
                  >
                    下一步
                  </button>
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <h2 className="text-xl font-semibold">先建立空白日曆</h2>
                <p>
                  {name} ·{" "}
                  {kind === "villa"
                    ? "包棟"
                    : kind === "mixed"
                      ? "包棟與單房"
                      : "單房"}
                </p>
                <p className="text-sm text-slate-600">
                  訂房會保存在工作區。Google Sheet
                  可在建立後從日曆選擇一次匯入；需要協助也可先提出諮詢。
                </p>
                <div className="flex gap-3">
                  <button
                    className={secondary}
                    disabled={busy}
                    onClick={() => setStep(2)}
                  >
                    上一步
                  </button>
                  <button className={button} disabled={busy} onClick={create}>
                    {busy ? "建立中…" : "建立旅宿，開始使用"}
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {error && (
          <p
            role="alert"
            className="mt-5 rounded-xl bg-red-50 p-4 text-red-800"
          >
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
