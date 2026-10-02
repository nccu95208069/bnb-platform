"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Modal } from "../customer-workspaces/modal";
import { api } from "../customer-workspaces/client";
import type { IntakeResult } from "@/lib/customer-intake/types";
import { ServiceLanding } from "./service-landing";
const button = "service-button service-button-primary";
const secondary = "service-button service-button-secondary";
const field = "service-field";
const kinds = [
  { value: "villa", label: "包棟", detail: "整棟一起出租" },
  { value: "rooms", label: "單房", detail: "每間房分開訂" },
  { value: "mixed", label: "兩者都有", detail: "可以包棟，也接單房" },
] as const;
export function ServiceJoin({
  enabled,
  preview = false,
  shareEmail,
  contactEmail,
}: {
  enabled: boolean;
  preview?: boolean;
  shareEmail: string;
  contactEmail: string;
}) {
  const [started, setStarted] = useState(false),
    [step, setStep] = useState(1),
    [name, setName] = useState(""),
    [kind, setKind] = useState(""),
    [roomText, setRoomText] = useState("");
  const [source, setSource] = useState("unknown"),
    [sourceDescription, setSourceDescription] = useState(""),
    [sheetUrl, setSheetUrl] = useState(""),
    [shared, setShared] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [contactName, setContactName] = useState(""),
    [email, setEmail] = useState(""),
    [phone, setPhone] = useState(""),
    [note, setNote] = useState(""),
    [consent, setConsent] = useState(false),
    [website, setWebsite] = useState("");
  const [intent, setIntent] = useState<"join" | "consultation" | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<IntakeResult | null>(null),
    [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null),
    requestKey = useRef("");
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const [completedIntent, setCompletedIntent] = useState<
    "join" | "consultation"
  >("consultation");
  useEffect(() => {
    requestKey.current = crypto.randomUUID();
    try {
      const raw = sessionStorage.getItem("bnb-intake-pending-v1");
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (
        !saved ||
        !["join", "consultation"].includes(saved.intent) ||
        typeof saved.requestKey !== "string"
      )
        return;
      pending.current = saved;
      requestKey.current = saved.requestKey;
      setIntent(saved.intent);
      setUncertain(true);
      const text = (key: string) =>
        typeof saved[key] === "string" ? saved[key] : "";
      setName(text("propertyName"));
      setKind(text("kind"));
      setSource(text("source") || "unknown");
      setSourceDescription(text("sourceDescription"));
      setSheetUrl(text("sheetUrl"));
      setShared(saved.sharingDeclared === true);
      setRoomText(
        Array.isArray(saved.rooms)
          ? saved.rooms.filter((r: unknown) => typeof r === "string").join("\n")
          : "",
      );
      setContactName(text("contactName"));
      setEmail(text("email"));
      setPhone(text("phone"));
      setNote(text("note"));
      setConsent(saved.consent === true);
    } catch {
      /* Storage may be unavailable; the in-memory retry still works. */
    }
  }, []);
  useEffect(() => {
    if (started) stepHeading.current?.focus();
  }, [step, started]);
  const rooms = roomText
    .split(/[\n,，]/)
    .map((r) => r.trim())
    .filter(Boolean);
  const roomValid =
    (kind === "villa" && !roomText.trim()) ||
    (rooms.length > 0 &&
      rooms.length <= 100 &&
      new Set(rooms).size === rooms.length &&
      rooms.every((r) => r.length <= 40));
  function consult() {
    setError("");
    setIntent(result ? completedIntent : "consultation");
  }
  function start() {
    setStarted(true);
    setTimeout(
      () =>
        document.getElementById("join-questions")?.scrollIntoView({
          behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
            .matches
            ? "instant"
            : "smooth",
          block: "start",
        }),
      0,
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !intent || !enabled) return;
    setBusy(true);
    setError("");
    pending.current ??= {
      requestKey: requestKey.current,
      intent,
      propertyName: name,
      kind,
      rooms: kind === "villa" && !rooms.length ? ["整棟"] : rooms,
      source,
      sourceDescription,
      sheetUrl,
      sharingDeclared: shared,
      contactName,
      email,
      phone,
      note,
      consent,
      website,
    };
    try {
      sessionStorage.setItem(
        "bnb-intake-pending-v1",
        JSON.stringify(pending.current),
      );
    } catch {}
    try {
      const saved = await api<IntakeResult>(
        "/api/customer-intake",
        "POST",
        pending.current,
      );
      setCompletedIntent(intent);
      setResult(saved);
      setUncertain(false);
      try {
        sessionStorage.removeItem("bnb-intake-pending-v1");
      } catch {}
    } catch (e) {
      setError((e as Error).message);
      const status = e instanceof Error && "status" in e ? Number(e.status) : 0;
      if (status >= 400 && status < 500 && status !== 409) {
        pending.current = null;
        setUncertain(false);
        try {
          sessionStorage.removeItem("bnb-intake-pending-v1");
        } catch {}
      } else setUncertain(true);
    } finally {
      setBusy(false);
    }
  }
  const consultButton = (className = secondary) => (
    <button className={className} onClick={consult}>
      <MessageCircle size={18} aria-hidden className="mr-2 inline" />
      專人諮詢
    </button>
  );
  return (
    <main className="service-site" lang="zh-Hant">
      {preview && (
        <p role="status" className="service-preview">
          預覽模式 ·
          請只填測試資料，此頁不會寄出真實通知。測試儲存服務停止後資料會清除。
        </p>
      )}
      <ServiceLanding
        onStart={start}
        onConsult={consult}
        contactEmail={contactEmail}
      >
        {started && (
          <section id="join-questions" className="service-questionnaire">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-medium">加入使用 · {step} / 3</p>
              {consultButton()}
            </div>
            <div
              className="mb-6 flex gap-2"
              role="group"
              aria-label={`目前第 ${step} 步，共 3 步`}
            >
              {[1, 2, 3].map((s) => (
                <span
                  key={s}
                  className={`h-1.5 flex-1 rounded-full ${s <= step ? "bg-[#9b4c35]" : "bg-[#ded8cb]"}`}
                />
              ))}
            </div>
            <div className="service-question-card">
              <h2
                ref={stepHeading}
                tabIndex={-1}
                className="service-question-title"
              >
                {step === 1 ? (
                  "先認識你的旅宿"
                ) : step === 2 ? (
                  "有哪些房間？"
                ) : (
                  <>
                    目前用 Google Sheet
                    <br />
                    記錄訂房嗎？
                  </>
                )}
              </h2>
              {step === 1 && (
                <>
                  <label className="block">
                    旅宿名稱
                    <input
                      className={field}
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="例如：山邊小屋"
                      autoComplete="organization"
                    />
                  </label>
                  <fieldset className="mt-6">
                    <legend className="mb-3">主要怎麼接待客人？</legend>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {kinds.map((k) => (
                        <button
                          key={k.value}
                          aria-pressed={kind === k.value}
                          className="service-choice"
                          onClick={() => setKind(k.value)}
                        >
                          <span className="block font-semibold">{k.label}</span>
                          <span className="mt-2 block text-sm text-[#686258]">
                            {k.detail}
                          </span>
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <button
                    className={`${button} mt-7`}
                    disabled={!name.trim() || !kind}
                    onClick={() => setStep(2)}
                  >
                    下一步：房間{" "}
                    <ArrowRight size={17} className="ml-1 inline" aria-hidden />
                  </button>
                </>
              )}
              {step === 2 && (
                <>
                  <p className="mb-4 leading-7 text-[#686258]">
                    {kind === "villa"
                      ? "整棟一起出租，可以先以「整棟」開始；也可以填上實際房間。"
                      : "把房號或房間名稱列出來，每行一間，也可以用逗號分隔。"}
                  </p>
                  <label className="block">
                    {kind === "villa"
                      ? "整棟內的房間（可略過）"
                      : "房號或房間名稱"}
                    <textarea
                      className={field}
                      rows={5}
                      maxLength={4200}
                      placeholder={"101\n102\n201"}
                      value={roomText}
                      onChange={(e) => setRoomText(e.target.value)}
                    />
                  </label>
                  {kind === "mixed" && (
                    <p className="mt-3 text-sm text-[#686258]">
                      這次先以全部房間可包棟來登記；若有不同棟別或部分包棟，請選專人諮詢補充。
                    </p>
                  )}
                  <div className="mt-7 flex flex-wrap gap-3">
                    <button className={secondary} onClick={() => setStep(1)}>
                      上一步
                    </button>
                    <button
                      className={button}
                      disabled={!roomValid}
                      onClick={() => setStep(3)}
                    >
                      下一步：目前的資料
                    </button>
                  </div>
                </>
              )}
              {step === 3 && (
                <>
                  <p className="mb-5 leading-7 text-[#686258]">
                    不必為了加入，先把原本的記錄重做一遍。
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[
                      ["sheet", "是，我用 Google Sheet"],
                      ["other", "不是／我不確定"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        aria-pressed={source === value}
                        onClick={() => {
                          setSource(value);
                          setShared(false);
                        }}
                        className="service-choice"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {source === "sheet" && (
                    <div className="mt-6 space-y-5">
                      <label className="block">
                        Google Sheet 連結
                        <input
                          className={field}
                          type="url"
                          placeholder="https://docs.google.com/spreadsheets/d/…"
                          value={sheetUrl}
                          onChange={(e) => {
                            setSheetUrl(e.target.value);
                            setShared(false);
                          }}
                          maxLength={500}
                        />
                      </label>
                      <div className="rounded-2xl bg-[#f5f1e8] p-5">
                        <h3 className="font-semibold">
                          把這份試算表分享給我們
                        </h3>
                        <ol className="mt-3 list-decimal space-y-3 pl-5 text-sm leading-7">
                          <li>打開試算表，點右上角「共用」。</li>
                          <li>
                            加入{" "}
                            <strong className="mt-1 block break-all font-mono text-sm font-semibold">
                              {shareEmail}
                            </strong>
                            <button
                              type="button"
                              className="service-button service-button-secondary mt-2"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(
                                    shareEmail,
                                  );
                                  setCopyMessage("已複製分享帳號");
                                } catch {
                                  setCopyMessage("請選取上方帳號複製");
                                }
                              }}
                            >
                              複製分享帳號
                            </button>
                            {copyMessage && (
                              <span
                                role="status"
                                className="ml-2 text-sm text-[#9b4c35]"
                              >
                                {copyMessage}
                              </span>
                            )}
                            。
                          </li>
                          <li>
                            權限選「檢視者」，按「傳送」。一般存取權維持「受限制」，不需公開。
                          </li>
                        </ol>
                        <p className="mt-4 text-sm text-[#686258]">
                          只用來核對你的房間與訂房格式；目前不會修改原表或持續同步。
                        </p>
                      </div>
                      <label className="flex items-start gap-3 text-sm leading-7">
                        <input
                          type="checkbox"
                          checked={shared}
                          onChange={(e) => setShared(e.target.checked)}
                          className="mt-2 size-4 shrink-0"
                        />
                        我已將這份試算表分享給上述帳號，了解仍需核對權限與內容。
                      </label>
                      <div className="flex flex-wrap gap-3">
                        <button
                          className={button}
                          disabled={!sheetUrl.trim() || !shared}
                          onClick={() => {
                            setError("");
                            setIntent(result ? completedIntent : "join");
                          }}
                        >
                          填寫聯絡方式，送出加入申請
                        </button>
                        {consultButton()}
                      </div>
                      <p className="text-sm text-[#686258]">
                        不會分享、想先了解，或資料比較複雜，都可以選專人諮詢。
                      </p>
                    </div>
                  )}
                  {source === "other" && (
                    <div className="mt-6 rounded-2xl bg-[#f0e9dc] p-5">
                      <h3 className="text-lg font-semibold">
                        讓專人幫你找合適的開始方式
                      </h3>
                      <p className="mt-3 text-sm leading-7 text-[#686258]">
                        紙本、Excel、手機記事本、訂房系統，或還沒有固定記錄方式，都可以先聊聊。你不用現在上傳客人資料。
                      </p>
                      <label className="mt-4 block text-sm">
                        目前怎麼記錄？（選填）
                        <input
                          className={field}
                          placeholder="例如：紙本月曆、Excel"
                          value={sourceDescription}
                          onChange={(e) => setSourceDescription(e.target.value)}
                          maxLength={300}
                        />
                      </label>
                      <button className={`${button} mt-5`} onClick={consult}>
                        請專人協助我開始
                      </button>
                    </div>
                  )}
                  <button
                    className={`${secondary} mt-7`}
                    onClick={() => setStep(2)}
                  >
                    上一步
                  </button>
                </>
              )}
            </div>
          </section>
        )}
      </ServiceLanding>
      {intent && (
        <Modal
          label={intent === "join" ? "送出加入申請" : "專人諮詢"}
          locked={busy || uncertain}
          onClose={() => {
            setIntent(null);
            setError("");
          }}
        >
          <div className="service-contact">
            <div className="flex items-start justify-between gap-3">
              <h2 className="service-contact-title">
                {result
                  ? "需求已收到"
                  : intent === "join"
                    ? "留下聯絡方式"
                    : "聊聊你的旅宿。"}
              </h2>
              <button
                className={secondary}
                disabled={busy || uncertain}
                onClick={() => {
                  setIntent(null);
                  setError("");
                }}
              >
                關閉
              </button>
            </div>
            {result ? (
              <div className="mt-6 space-y-4">
                <p>
                  已保存你的
                  {completedIntent === "join" ? "加入申請" : "諮詢需求"}
                  ，接下來會聯絡你，核對適合的設定與資料方式。
                </p>
                <p className="rounded-xl bg-[#f0e9dc] p-4 text-sm leading-7">
                  {result.preview
                    ? "這是測試需求，預覽模式沒有寄出 Email。"
                    : result.notification === "accepted"
                      ? "通知信已交由寄信服務發送給專人。"
                      : "需求已保存，但通知信尚未確認送出。你可以使用下方 Email，附上申請編號聯絡我們，不必再填一次。"}
                </p>
                <p className="text-sm">
                  {source === "sheet" && "Sheet 權限尚待核對；"}
                  目前沒有匯入或更改你的訂房。
                </p>
                <p className="break-all text-sm text-[#70695f]">
                  申請編號：{result.id}
                </p>
                <a
                  className="inline-block text-[#9b4c35] underline"
                  href={`mailto:${contactEmail}?subject=${encodeURIComponent(`民宿 OS 申請 ${result.id}`)}`}
                >
                  Email 聯絡我們
                </a>
              </div>
            ) : (
              <form onSubmit={submit} className="mt-5 space-y-4">
                <p className="text-sm leading-7 text-[#686258]">
                  {intent === "join"
                    ? "我們會核對分享權限與資料，再協助你開通使用。"
                    : "不用先註冊或填完整份問卷。已回答的內容會一起帶給專人，你不必重填。"}
                </p>
                {!enabled && (
                  <p
                    role="status"
                    className="rounded-xl bg-amber-50 p-4 text-sm"
                  >
                    線上申請目前尚未開放，請先{" "}
                    <a className="underline" href={`mailto:${contactEmail}`}>
                      Email 聯絡我們
                    </a>
                    。
                  </p>
                )}
                <fieldset disabled={busy || uncertain} className="space-y-4">
                  <label className="block">
                    怎麼稱呼你？
                    <input
                      className={field}
                      required
                      maxLength={80}
                      autoComplete="name"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    Email
                    <input
                      className={field}
                      required
                      type="email"
                      maxLength={254}
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    電話或 LINE ID（選填）
                    <input
                      className={field}
                      maxLength={60}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    想先了解什麼？（選填）
                    <textarea
                      className={field}
                      rows={3}
                      maxLength={2000}
                      placeholder="例如：如何搬資料、不同棟別怎麼設定"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </label>
                  <div className="absolute -left-[9999px]" aria-hidden>
                    <label>
                      Website
                      <input
                        name="website"
                        value={website}
                        tabIndex={-1}
                        autoComplete="off"
                        onChange={(e) => setWebsite(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="flex items-start gap-3 text-sm leading-7">
                    <input
                      required
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="mt-2 size-4 shrink-0"
                    />
                    同意將聯絡方式、問卷與提供的連結交給服務人員，用於回覆這次需求。請不要在備註填入客人個資或密碼。
                  </label>
                </fieldset>
                {error && (
                  <p
                    role="alert"
                    className="rounded-xl bg-red-50 p-4 text-sm text-red-800"
                  >
                    {error}
                  </p>
                )}
                {uncertain && (
                  <p role="status" className="text-sm text-amber-800">
                    送出結果尚未確認。內容暫時鎖定，請用下方按鈕重試相同需求。
                  </p>
                )}
                <button
                  className={`${button} w-full`}
                  disabled={busy || !enabled || !consent}
                >
                  {busy
                    ? "送出中…"
                    : uncertain
                      ? "重試相同需求"
                      : intent === "join"
                        ? "送出加入申請"
                        : "送出專人諮詢"}
                </button>
                <p className="text-xs leading-6 text-[#70695f]">
                  系統會保存申請並通知專人。線上申請資料保留 90
                  天；通知郵件另由服務人員保管。若需更正或刪除，請以申請編號聯絡我們。
                </p>
              </form>
            )}
          </div>
        </Modal>
      )}
    </main>
  );
}
