"use client";

import { useEffect, useRef, useState } from "react";
import { api, button, field, secondary } from "../customer-workspaces/client";
import { useCommand } from "../customer-workspaces/use-command";

type RoomConfig = {
  roomTypeId: string;
  enabled: boolean;
  units: string | number;
  capacity: string | number;
  nightly: string | number;
};
type RoomMapping = { roomTypeId: string; roomIds: string[] };
type OwnerWorkspace = {
  slug: string;
  name: string;
  version: number;
  properties: {
    id: string;
    name: string;
    kind: string;
    rooms: { id: string; name: string }[];
  }[];
};
type OwnerConnectionView = {
  authenticated: true;
  email: string;
  connection: {
    id: string;
    siteName: string;
    state: "awaiting_owner" | "connected";
    configurationHash: string;
    expiresAt: string;
    calendarUrl?: string;
    config: {
      sellingMode: "rooms" | "whole_house" | "mixed";
      opensOn: string;
      closesOn: string;
      wholeHouseNightly: string | number;
      transferInstructions: string;
      cancellationPolicy: string;
      rooms: RoomConfig[];
    };
    roomRecords: { id: string; name: string }[];
    binding?: {
      slug: string;
      propertyId: string;
      version: number;
      roomMappings: RoomMapping[];
      lineConnected: boolean;
      linePairingId?: string;
      lineVerifiedAt?: string;
    };
  };
  workspaces: OwnerWorkspace[];
};
type OwnerView = { authenticated: false } | OwnerConnectionView;
type Approval = {
  action: "approve";
  connectionId: string;
  requestKey: string;
  confirmed: true;
  mode: "new" | "existing";
  slug: string;
  propertyId?: string;
  version?: number;
  roomMappings?: RoomMapping[];
};

const endpoint = "/api/website-booking/owner";
const connectionPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function money(value: string | number) {
  const amount = Number(value);
  return String(value).trim() && Number.isFinite(amount) && amount > 0
    ? new Intl.NumberFormat("zh-TW", {
        style: "currency",
        currency: "TWD",
        maximumFractionDigits: 2,
      }).format(amount)
    : "未設定";
}

function displayTime(value: string) {
  return Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "請返回建站台重新確認";
}

function calendarLink(value?: string) {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin &&
      /^\/w\/[a-z0-9][a-z0-9-]{2,47}\/calendar$/.test(url.pathname)
      ? url.pathname + url.search
      : null;
  } catch {
    return null;
  }
}

function isOwnerMismatch(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "WEBSITE_OWNER_MISMATCH";
}

export function OwnerConnection({ connectionId }: { connectionId: string }) {
  const [view, setView] = useState<OwnerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [preparingLogin, setPreparingLogin] = useState(false);
  const prepared = useRef(false);
  const requestingLogin = useRef(false);
  const login = useCommand(endpoint);
  const valid = connectionPattern.test(connectionId);
  const fetchView = () =>
    api<OwnerView>(`${endpoint}?connection=${encodeURIComponent(connectionId)}`);

  useEffect(() => {
    if (!connectionPattern.test(connectionId)) return;
    let active = true;
    api<OwnerView>(`${endpoint}?connection=${encodeURIComponent(connectionId)}`)
      .then((next) => {
        if (active) setView(next);
      })
      .catch((caught) => {
        if (active) {
          if (isOwnerMismatch(caught)) setView({ authenticated: false });
          setError((caught as Error).message);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [connectionId]);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setView(await fetchView());
    } catch (caught) {
      if (isOwnerMismatch(caught)) setView({ authenticated: false });
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function requestLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestingLogin.current) return;
    requestingLogin.current = true;
    setError("");
    try {
      if (!prepared.current) {
        setPreparingLogin(true);
        await api(endpoint, "POST", { action: "login-prepare", connectionId });
        prepared.current = true;
        setPreparingLogin(false);
      }
      const result = await login.execute<{ detail: string }>({
        action: "login-request",
        connectionId,
        email: email.trim(),
      });
      if (result) setNotice(result.data.detail);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      requestingLogin.current = false;
      setPreparingLogin(false);
    }
  }

  return (
    <main className="min-h-dvh bg-stone-50 px-5 py-10 text-slate-900 sm:py-14">
      <div className="mx-auto max-w-3xl space-y-6">
        <header>
          <p className="text-sm font-semibold tracking-widest text-teal-800">
            SWEETFUN OS
          </p>
          <h1 className="mt-3 text-3xl font-semibold">連接官網訂房日曆</h1>
          <p className="mt-3 leading-7 text-slate-600">
            由業主確認網站、房間與販售設定，官網訂單會寫入同一份 OS 日曆。
          </p>
        </header>
        {!valid ? (
          <p role="alert" className="rounded-xl bg-amber-50 p-5 text-amber-900">
            連接網址不完整。請返回建站台，重新開啟「連接 Sweetfun OS 日曆」。
          </p>
        ) : view?.authenticated ? (
          <ApprovalForm
            key={connectionId}
            view={view}
            fetchView={fetchView}
            onView={setView}
          />
        ) : loading ? (
          <p role="status">正在讀取連接設定…</p>
        ) : view ? (
          <section className="space-y-5 rounded-2xl border bg-white p-5 sm:p-7">
            <h2 className="text-xl font-semibold">先驗證業主信箱</h2>
            <p className="leading-7 text-slate-600">
              請填寫建站台設定的業主 Email，並在同一個瀏覽器開啟信件中的登入連結。驗證後會返回這裡核對設定。
            </p>
            <form onSubmit={requestLogin} className="space-y-4">
              <label className="block">
                業主 Email
                <input
                  className={field}
                  type="email"
                  autoComplete="email"
                  maxLength={160}
                  required
                  value={email}
                  disabled={preparingLogin || login.busy || login.uncertain}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <button
                className={button}
                disabled={preparingLogin || login.busy}
              >
                {preparingLogin || login.busy
                  ? "正在寄送…"
                  : login.uncertain
                    ? "確認原寄信請求"
                    : "寄送登入連結"}
              </button>
            </form>
            {login.uncertain && (
              <p className="rounded-xl bg-amber-50 p-4 text-amber-900">
                寄送結果尚未確認，請先查看信箱；重試會核對同一筆請求。
              </p>
            )}
            {notice && <p role="status" className="break-words">{notice}</p>}
            {login.error && <ErrorMessage message={login.error} />}
            <button className={secondary} onClick={() => void refresh()}>
              重新查詢登入狀態
            </button>
          </section>
        ) : null}
        {error && (
          <div className="space-y-3">
            <ErrorMessage message={error} />
            {valid && (
              <button
                className={secondary}
                disabled={loading}
                onClick={() => void refresh()}
              >
                重新讀取連接設定
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p role="alert" className="break-words rounded-xl bg-red-50 p-4 text-red-800">
      {message}
    </p>
  );
}

type LinePairingInstruction = {
  pairingId: string;
  pairingToken: string;
  expiresAt: string;
  command: string;
};

function LinePairing({
  view,
  fetchView,
  onView,
}: {
  view: OwnerConnectionView;
  fetchView: () => Promise<OwnerView>;
  onView: (next: OwnerView) => void;
}) {
  const command = useCommand(endpoint);
  const [pairing, setPairing] = useState<LinePairingInstruction | null>(null);
  const [expired, setExpired] = useState(false);
  const [checking, setChecking] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [notice, setNotice] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const checkingRef = useRef(false);
  const binding = view.connection.binding;
  const connected = binding?.lineConnected === true;
  const matched = Boolean(
    connected && pairing && binding?.linePairingId === pairing.pairingId,
  );
  const pending = Boolean(pairing && !matched) || command.uncertain;

  useEffect(() => {
    if (!pairing || expired) return;
    const timer = window.setTimeout(
      () => setExpired(true),
      Math.max(0, Date.parse(pairing.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [pairing, expired]);

  async function prepare() {
    if (command.busy || checkingRef.current) return;
    setPairing(null);
    setExpired(false);
    setNotice("");
    setCopyNotice("");
    setStatusError("");
    const result = await command.execute<LinePairingInstruction>({
      action: "line-prepare",
      connectionId: view.connection.id,
    });
    if (result) {
      setPairing(result.data);
      setExpired(Date.parse(result.data.expiresAt) <= Date.now());
    }
  }

  async function checkStatus() {
    if (command.busy || checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    setStatusError("");
    setNotice("");
    try {
      const next = await fetchView();
      if (!next.authenticated) {
        throw new Error("登入已失效，請重新整理此頁，在原本的瀏覽器重新驗證。");
      }
      if (next.connection.state !== "connected") {
        throw new Error("日曆連接狀態尚待核對，請重新讀取連接設定。");
      }
      onView(next);
      const nextBinding = next.connection.binding;
      if (pairing && nextBinding?.lineConnected && nextBinding.linePairingId === pairing.pairingId) {
        setCopyNotice("");
      } else if (pairing || command.uncertain) {
        setNotice("尚未核對到本次配對完成。請確認已在一對一私訊送出指令，再重新查詢。");
      } else if (!nextBinding?.lineConnected) {
        setNotice("目前尚未完成 LINE 配對。請先取得指令，傳給訂房小助手。");
      }
    } catch (caught) {
      setStatusError((caught as Error).message);
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }

  async function copyCommand() {
    if (!pairing || matched || expired || Date.parse(pairing.expiresAt) <= Date.now()) return;
    try {
      await window.navigator.clipboard.writeText(pairing.command);
      setCopyNotice("已複製，請貼至訂房小助手的一對一 LINE 私訊。");
    } catch {
      setCopyNotice("瀏覽器無法自動複製，請選取上方指令手動複製。");
    }
  }

  return (
    <section className="space-y-5 rounded-2xl border bg-white p-5 sm:p-7" aria-labelledby="owner-line-pairing-title">
      <div>
        <h2 id="owner-line-pairing-title" className="text-xl font-semibold">業主 LINE 通知</h2>
        <p role="status" className="mt-2 font-medium text-teal-900">
          {matched
            ? "本次 LINE 配對完成"
            : connected
              ? pending
                ? "既有 LINE 維持連接，新配對待完成"
                : "LINE 已配對"
              : "LINE 尚未配對"}
        </p>
        {connected && binding?.lineVerifiedAt && (
          <p className="mt-2 text-sm text-slate-500">最近配對時間：{displayTime(binding.lineVerifiedAt)}（台北時間）</p>
        )}
      </div>
      <p className="leading-7 text-slate-600">
        將配對指令傳給訂房小助手；完成後回來查詢配對狀態。請使用一對一 LINE 私訊，不支援群組，也不需要填寫 LINE ID。
      </p>
      {connected && !pending && !command.busy && (
        <p className="text-sm leading-6 text-slate-600">配對狀態由 OS 核對；每筆訂房的通知是否已送出，仍以該筆訂單的通知狀態為準。</p>
      )}
      {pairing && !matched && (
        <div className="space-y-3 rounded-xl bg-stone-50 p-4">
          <label className="block font-medium">
            LINE 配對指令
            <textarea
              className={`${field} break-all font-mono text-sm font-normal`}
              rows={3}
              readOnly
              value={pairing.command}
              autoComplete="off"
              spellCheck={false}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p className="text-sm leading-6 text-slate-600">有效期限：{displayTime(pairing.expiresAt)}（台北時間）。此指令有效 10 分鐘、僅可使用一次，請勿轉交他人。</p>
          {expired ? (
            <p role="status" className="text-amber-900">指令已過期，請產生新的配對指令。</p>
          ) : (
            <button type="button" className={secondary} onClick={() => void copyCommand()}>複製指令</button>
          )}
          {copyNotice && <p role="status" className="text-sm leading-6">{copyNotice}</p>}
          <p className="text-sm leading-6 text-slate-600">送出後仍須由訂房小助手完成驗證；若服務尚在準備中，這裡會維持待配對狀態。</p>
        </div>
      )}
      {command.uncertain && (
        <p role="status" className="rounded-xl bg-amber-50 p-4 leading-7 text-amber-900">取得配對指令的結果尚未確認。請取回原指令；重試會沿用同一筆請求。</p>
      )}
      {notice && <p role="status" className="leading-7 text-slate-600">{notice}</p>}
      {command.error && <ErrorMessage message={command.error} />}
      {statusError && <ErrorMessage message={statusError} />}
      <div className="flex flex-wrap gap-3">
        {(!pairing || matched || expired || command.uncertain) && (
          <button type="button" className={button} disabled={command.busy || checking} onClick={() => void prepare()}>
            {command.busy
              ? "正在取得配對指令…"
              : command.uncertain
                ? "取回原配對指令"
                : expired && !matched
                  ? "產生新的配對指令"
                  : connected
                    ? "重新配對 LINE"
                    : "取得 LINE 配對指令"}
          </button>
        )}
        <button type="button" className={secondary} disabled={command.busy || checking} onClick={() => void checkStatus()}>
          {checking ? "正在查詢配對狀態…" : "重新查詢配對狀態"}
        </button>
      </div>
    </section>
  );
}

function ApprovalForm({
  view,
  fetchView,
  onView,
}: {
  view: OwnerConnectionView;
  fetchView: () => Promise<OwnerView>;
  onView: (next: OwnerView) => void;
}) {
  const { connection, workspaces } = view;
  const binding = connection.binding;
  const [mode, setMode] = useState<"new" | "existing">(binding ? "existing" : "new");
  const [slug, setSlug] = useState(binding?.slug || "");
  const [propertyId, setPropertyId] = useState(binding?.propertyId || "");
  const [mappings, setMappings] = useState<Record<string, string[]>>(() =>
    Object.fromEntries((binding?.roomMappings || []).map((r) => [r.roomTypeId, r.roomIds])),
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const running = useRef(false);
  const pending = useRef<Approval | null>(null);
  const workspace = workspaces.find((w) => w.slug === slug);
  const property = workspace?.properties.find((p) => p.id === propertyId);
  const rooms = connection.config.rooms.filter((r) => r.enabled);
  const selectedIds = rooms.flatMap((r) => mappings[r.roomTypeId] || []).filter(Boolean);
  const completeMapping = Boolean(property) && rooms.every((r) => {
    const ids = mappings[r.roomTypeId] || [];
    return ids.length === Number(r.units) && ids.every((id) => property?.rooms.some((room) => room.id === id));
  }) && new Set(selectedIds).size === selectedIds.length;
  const boundRoomIds = binding?.roomMappings.flatMap((r) => r.roomIds);
  const unchangedPool = !boundRoomIds || (boundRoomIds.length === selectedIds.length && boundRoomIds.every((id) => selectedIds.includes(id)));
  const locked = busy || uncertain;
  const ready = confirmed && (mode === "new"
    ? /^[a-z0-9][a-z0-9-]{2,47}$/.test(slug)
    : completeMapping && unchangedPool);
  const calendarUrl = calendarLink(connection.calendarUrl);
  const roomName = (id: string) => connection.roomRecords.find((r) => r.id === id)?.name || "未命名房型";

  useEffect(() => {
    if (!busy && !uncertain) return;
    const keepPending = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", keepPending);
    return () => window.removeEventListener("beforeunload", keepPending);
  }, [busy, uncertain]);

  async function checkResult() {
    const next = await fetchView();
    if (!next.authenticated) {
      throw new Error("登入已失效，請重新整理此頁，在原本的瀏覽器重新驗證後核對連接結果。");
    }
    onView(next);
    if (next.connection.state === "connected") {
      pending.current = null;
      setUncertain(false);
      return true;
    }
    return false;
  }

  async function inspect() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      if (!(await checkResult())) {
        setStatus("目前尚未查到已完成的連接。請保留此頁，稍後再查詢或重試原確認。");
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function approve(event?: React.FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (running.current || (!pending.current && !ready)) return;
    running.current = true;
    pending.current ??= {
      action: "approve",
      connectionId: connection.id,
      requestKey: crypto.randomUUID(),
      confirmed: true,
      mode,
      slug,
      ...(mode === "existing" ? {
        propertyId,
        version: binding?.version ?? workspace?.version,
        roomMappings: rooms.map((r) => ({ roomTypeId: r.roomTypeId, roomIds: [...(mappings[r.roomTypeId] || [])] })),
      } : {}),
    };
    setBusy(true);
    setError("");
    setStatus("");
    let accepted = false;
    try {
      const result = await api<{ state: string }>(endpoint, "POST", pending.current);
      accepted = true;
      if (result.state !== "connected" || !(await checkResult())) {
        throw new Error("尚未核對到完成結果，請查詢原連接狀態。");
      }
    } catch (caught) {
      const code = caught instanceof Error && "status" in caught ? Number(caught.status) : 0;
      if (!accepted && !uncertain && code >= 400 && code < 500) {
        pending.current = null;
        setConfirmed(false);
      } else {
        setUncertain(true);
      }
      setError((caught as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  if (connection.state === "connected") {
    return (
      <>
      <section className="space-y-5 rounded-2xl border border-teal-200 bg-white p-5 sm:p-7">
        <p role="status" className="text-xl font-semibold text-teal-900">{connection.siteName} 已連接 OS 日曆</p>
        <p className="leading-7 text-slate-600">業主：{view.email}。你可以回到建站台檢查連接狀態，並確認已發布這份設定。</p>
        {calendarUrl && <a className={`${button} inline-block`} href={calendarUrl}>開啟 OS 日曆</a>}
        <p className="text-sm leading-6 text-slate-500">此頁顯示日曆連接結果；實際收單與通知狀態仍以官網及個別訂單的結果為準。</p>
      </section>
      <LinePairing view={view} fetchView={fetchView} onView={onView} />
      </>
    );
  }

  return (
    <form onSubmit={approve} className="space-y-6">
      <section className="space-y-5 rounded-2xl border bg-white p-5 sm:p-7">
        <div>
          <h2 className="break-words text-2xl font-semibold">{connection.siteName}</h2>
          <p className="mt-2 break-words text-slate-600">已驗證業主：{view.email}</p>
          <p className="mt-2 text-sm text-slate-500">確認期限：{displayTime(connection.expiresAt)}（台北時間）</p>
        </div>
        <div className="rounded-xl bg-stone-50 p-4 leading-7">
          <p>販售方式：{{ rooms: "按房型預訂", whole_house: "只接受包棟", mixed: "房型與包棟皆可" }[connection.config.sellingMode]}</p>
          <p>開放住宿日：{connection.config.opensOn} 至 {connection.config.closesOn}</p>
          <p className="text-sm text-slate-600">最後住宿日的隔天可退房；退房日不占房。</p>
        </div>
        <div className="space-y-3">
          <h3 className="font-semibold">房型與實際房間</h3>
          {rooms.map((r) => (
            <div key={r.roomTypeId} className="rounded-xl border p-4">
              <h4 className="break-words font-medium">{roomName(r.roomTypeId)}</h4>
              <p className="mt-2 text-sm leading-6 text-slate-600">{r.units} 間實體房間 · 每房最多 {r.capacity} 人</p>
              {connection.config.sellingMode !== "whole_house" && <p className="mt-1">每房每晚 {money(r.nightly)}</p>}
            </div>
          ))}
          {connection.config.sellingMode !== "rooms" && (
            <div className="rounded-xl bg-teal-50 p-4 text-teal-950">
              <p className="font-medium">包棟每晚 {money(connection.config.wholeHouseNightly)}</p>
              <p className="mt-2 text-sm leading-6">包棟占用上列全部啟用房型的實體房間，與單房預訂共用房況。</p>
            </div>
          )}
        </div>
        <div className="space-y-4 border-t pt-5">
          <div><h3 className="font-semibold">旅客可見的匯款說明</h3><p className="mt-2 whitespace-pre-wrap break-words leading-7 text-slate-600">{connection.config.transferInstructions}</p></div>
          <div><h3 className="font-semibold">修改與取消規則</h3><p className="mt-2 whitespace-pre-wrap break-words leading-7 text-slate-600">{connection.config.cancellationPolicy}</p></div>
          <p className="rounded-xl bg-stone-50 p-4 text-sm leading-6">保留從實際占房成功起算 24 小時；到期後仍占房，等待業主決定延長或釋出。確認實收訂金後，同一筆訂單轉為正式訂房。</p>
        </div>
      </section>
      <section className="space-y-5 rounded-2xl border bg-white p-5 sm:p-7">
        <h2 className="text-xl font-semibold">{binding ? "確認既有日曆設定變更" : "選擇要連接的日曆"}</h2>
        {binding && <p className="text-sm leading-6 text-slate-600">這個網站已有日曆綁定。本次核對新的販售設定，維持原本的日曆及房間對映。</p>}
        {binding && (!completeMapping || !unchangedPool) && <p role="alert" className="rounded-xl bg-amber-50 p-4 leading-7 text-amber-900">新的房型或實體房間數與既有綁定不符。請先回建站台恢復原房型與間數，或完成受控庫存調整後再連接；此頁無法直接更換已綁定的房間。</p>}
        <fieldset disabled={locked || Boolean(binding)} className="space-y-5 disabled:opacity-70">
          {!binding && <div className="flex flex-wrap gap-3">
            <button type="button" className={mode === "new" ? button : secondary} aria-pressed={mode === "new"} onClick={() => { setMode("new"); setSlug(""); setPropertyId(""); setMappings({}); setConfirmed(false); }}>建立全新日曆</button>
            <button type="button" className={mode === "existing" ? button : secondary} aria-pressed={mode === "existing"} disabled={!workspaces.length} onClick={() => { setMode("existing"); setSlug(""); setPropertyId(""); setMappings({}); setConfirmed(false); }}>使用既有日曆</button>
          </div>}
          {mode === "new" ? (
            <label className="block">日曆網址代稱
              <input className={field} value={slug} required maxLength={48} pattern="[a-z0-9][a-z0-9-]{2,47}" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="my-guesthouse" onChange={(event) => { setSlug(event.target.value.toLowerCase()); setConfirmed(false); }} />
              <span className="mt-2 block text-sm leading-6 text-slate-500">3～48 個小寫英文字母、數字或連字號。新日曆會依上列房型與間數建立實體房間，無需舊 Sheet 或 OwlNest。</span>
            </label>
          ) : (
            <>
              <label className="block">旅宿工作區
                <select className={field} value={slug} required onChange={(event) => { setSlug(event.target.value); setPropertyId(""); setMappings({}); setConfirmed(false); }}>
                  <option value="">請選擇工作區</option>
                  {workspaces.map((w) => <option key={w.slug} value={w.slug}>{w.name}</option>)}
                </select>
              </label>
              <label className="block">館別
                <select className={field} value={propertyId} required disabled={!workspace || Boolean(binding)} onChange={(event) => { setPropertyId(event.target.value); setMappings({}); setConfirmed(false); }}>
                  <option value="">請選擇館別</option>
                  {workspace?.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              {property && <div className="space-y-5">
                <p className="text-sm leading-6 text-slate-600">請逐間選擇對應的 OS 實體房間。每間房只能對應一個房型。</p>
                {rooms.map((r) => <fieldset key={r.roomTypeId} className="space-y-3 rounded-xl border p-4">
                  <legend className="px-1 font-medium">{roomName(r.roomTypeId)}</legend>
                  {Array.from({ length: Number(r.units) }, (_, i) => {
                    const selected = mappings[r.roomTypeId]?.[i] || "";
                    return <label key={i} className="block">{roomName(r.roomTypeId)}：第 {i + 1} 間
                      <select className={field} value={selected} required onChange={(event) => {
                        const next = Array.from({ length: Number(r.units) }, (_, index) => mappings[r.roomTypeId]?.[index] || "");
                        next[i] = event.target.value;
                        setMappings({ ...mappings, [r.roomTypeId]: next });
                        setConfirmed(false);
                      }}>
                        <option value="">請選擇實體房間</option>
                        {property.rooms.map((physical) => <option key={physical.id} value={physical.id} disabled={physical.id !== selected && selectedIds.includes(physical.id)}>{physical.name}</option>)}
                      </select>
                    </label>;
                  })}
                </fieldset>)}
              </div>}
            </>
          )}
        </fieldset>
        <label className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 leading-7">
          <input type="checkbox" className="mt-2 h-4 w-4 shrink-0 accent-teal-800" checked={confirmed} disabled={locked} onChange={(event) => setConfirmed(event.target.checked)} />
          <span>我確認上列業主信箱、房型、人數、房價、日期及旅客規則正確；已核對開放期間的既有訂單與封房，所有需要保留的日期都已登記在所選 OS 日曆。若建立全新日曆，我確認此範圍目前沒有尚未登記的訂單或封房。我了解目前僅以 OS 日曆管理房況，尚未串接的 Sheet、OwlNest 或其他管道不會自動占房。</span>
        </label>
        {uncertain && <p role="status" className="rounded-xl bg-amber-50 p-4 leading-7 text-amber-900">送出結果尚未確認。已保留原本的設定與請求，請先查詢結果，或重試同一筆確認；不要重新建立另一個日曆。</p>}
        {status && <p role="status" className="leading-7 text-slate-600">{status}</p>}
        {error && <ErrorMessage message={error} />}
        <div className="flex flex-wrap gap-3">
          <button className={button} disabled={busy || (!uncertain && !ready)}>{busy ? "正在核對…" : uncertain ? "重試原確認" : binding ? "確認並套用新設定" : "確認並連接日曆"}</button>
          <button type="button" className={secondary} disabled={busy} onClick={() => void inspect()}>查詢連接結果</button>
        </div>
      </section>
    </form>
  );
}
