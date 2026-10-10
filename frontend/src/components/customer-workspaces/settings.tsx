"use client";
import { useEffect, useState } from "react";
import type {
  Invitation,
  Membership,
  Pricing,
  Property,
  Role,
  WorkspaceView,
} from "@/lib/customer-workspaces/types";
import { api, button, field, secondary, today } from "./client";
import { useCommand } from "./use-command";
import { WorkspaceNav } from "./workspace-nav";
import { StandardSheetPanel } from "./standard-sheet";
const roles: [Role, string][] = [
  ["admin", "管理員：訂房、收退款及房價"],
  ["housekeeper", "管家：訂房、登記收款"],
  ["viewer", "僅查看：可看房價與收款"],
  ["viewer_no_price", "僅查看：不看金額，適合清潔協作"],
];
type Members = {
  version: number;
  members: Membership[];
  invitations: Omit<Invitation, "generation">[];
};
type Result = Partial<WorkspaceView> &
  Partial<Members> & {
    workspace?: WorkspaceView;
    propertyId?: string;
    delivery?: string;
  };
function ScopeFields({
  properties,
  all,
  ids,
  onChange,
}: {
  properties: Property[];
  all: boolean;
  ids: string[];
  onChange: (all: boolean, ids: string[]) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 font-medium">可以使用哪些旅宿</legend>
      <label className="flex gap-2">
        <input type="radio" checked={all} onChange={() => onChange(true, [])} />
        全部旅宿（含之後新增）
      </label>
      <label className="flex gap-2">
        <input
          type="radio"
          checked={!all}
          onChange={() => onChange(false, [])}
        />
        只開放選定旅宿
      </label>
      {!all && (
        <div className="flex flex-wrap gap-4 pl-5">
          {properties.map((p) => (
            <label key={p.id} className="flex gap-2">
              <input
                type="checkbox"
                checked={ids.includes(p.id)}
                onChange={(e) =>
                  onChange(
                    false,
                    e.target.checked
                      ? [...ids, p.id]
                      : ids.filter((id) => id !== p.id),
                  )
                }
              />
              {p.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
function MemberEditor({
  member,
  properties,
  locked,
  save,
}: {
  member: Membership;
  properties: Property[];
  locked: boolean;
  save: (input: Record<string, unknown>) => Promise<void>;
}) {
  const [role, setRole] = useState(member.role),
    [active, setActive] = useState(member.active),
    [all, setAll] = useState(member.allProperties),
    [ids, setIds] = useState(member.propertyIds);
  return (
    <details className="rounded-xl border p-4">
      <summary className="cursor-pointer font-medium">
        {member.email} ·{" "}
        {member.role === "owner" ? "業主" : member.active ? "使用中" : "已停用"}
      </summary>
      {member.role === "owner" ? (
        <p className="mt-3 text-sm">
          業主擁有全部旅宿的管理權，不能在此降級或停用。
        </p>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              action: "member",
              accountId: member.accountId,
              role,
              active,
              allProperties: all,
              propertyIds: ids,
            });
          }}
        >
          <fieldset disabled={locked} className="space-y-4">
            <label className="block">
              成員角色
              <select
                className={field}
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {roles.map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <ScopeFields
              properties={properties}
              all={all}
              ids={ids}
              onChange={(next, selected) => {
                setAll(next);
                setIds(selected);
              }}
            />
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
              />
              啟用此成員（取消後立即停止此工作區存取）
            </label>
            <button className={button}>保存成員權限</button>
          </fieldset>
        </form>
      )}
    </details>
  );
}
function PricingForm({
  property,
  locked,
  save,
}: {
  property: Property;
  locked: boolean;
  save: (input: Record<string, unknown>) => Promise<void>;
}) {
  const units = [
    ...(property.kind !== "villa" ? property.rooms : []),
    ...(property.kind !== "rooms" ? [{ id: "villa", name: "整棟" }] : []),
  ];
  const [enabled, setEnabled] = useState(property.pricing?.enabled ?? false),
    [base, setBase] = useState<Record<string, string>>(
      Object.fromEntries(
        Object.entries(property.pricing?.base ?? {}).map(([id, amount]) => [
          id,
          String(amount),
        ]),
      ),
    ),
    [overrides, setOverrides] = useState(
      (property.pricing?.overrides ?? []).map((r) => ({
        ...r,
        amount: String(r.amount),
      })),
    );
  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        const pricing: Pricing = {
          enabled,
          currency: "TWD",
          base: Object.fromEntries(
            Object.entries(base)
              .filter(([, value]) => value !== "")
              .map(([id, value]) => [id, Number(value)]),
          ),
          overrides: overrides.map((r) => ({ ...r, amount: Number(r.amount) })),
        };
        void save({ action: "pricing", propertyId: property.id, pricing });
      }}
    >
      <fieldset disabled={locked} className="space-y-5">
        <p className="text-sm leading-6 text-slate-600">
          先填每晚價格，再決定是否讓「尚未出售」清單顯示。空白代表尚未設定；0
          代表零元。此設定供清單報價參考，新增訂單仍以登記的整筆總額為準。
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {units.map((unit) => (
            <label className="block" key={unit.id}>
              {unit.name} 基本房價
              <input
                aria-label={`${unit.name} 基本房價`}
                className={field}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                value={base[unit.id] ?? ""}
                onChange={(e) =>
                  setBase({ ...base, [unit.id]: e.target.value })
                }
                placeholder="尚未設定"
              />
              <span className="text-xs text-slate-500">新臺幣／晚</span>
            </label>
          ))}
        </div>
        <h3 className="font-semibold">指定日期房價</h3>
        <p className="text-sm text-slate-600">
          指定日期會優先使用此價格；日期範圍包含起日和迄日。同一房間的範圍不能重疊。
        </p>
        {overrides.map((row, i) => (
          <div
            key={i}
            className="grid gap-3 rounded-xl border p-4 sm:grid-cols-5"
          >
            <label>
              房間
              <select
                className={field}
                value={row.roomId}
                onChange={(e) =>
                  setOverrides(
                    overrides.map((r, n) =>
                      n === i ? { ...r, roomId: e.target.value } : r,
                    ),
                  )
                }
              >
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              起日
              <input
                className={field}
                type="date"
                required
                value={row.from}
                onChange={(e) =>
                  setOverrides(
                    overrides.map((r, n) =>
                      n === i ? { ...r, from: e.target.value } : r,
                    ),
                  )
                }
              />
            </label>
            <label>
              迄日
              <input
                className={field}
                type="date"
                required
                value={row.to}
                min={row.from}
                onChange={(e) =>
                  setOverrides(
                    overrides.map((r, n) =>
                      n === i ? { ...r, to: e.target.value } : r,
                    ),
                  )
                }
              />
            </label>
            <label>
              每晚金額
              <input
                className={field}
                type="number"
                min="0"
                max="100000000"
                step="0.01"
                required
                value={row.amount}
                onChange={(e) =>
                  setOverrides(
                    overrides.map((r, n) =>
                      n === i ? { ...r, amount: e.target.value } : r,
                    ),
                  )
                }
              />
            </label>
            <button
              type="button"
              className={`${secondary} self-end`}
              onClick={() => setOverrides(overrides.filter((_, n) => n !== i))}
            >
              移除
            </button>
          </div>
        ))}
        <button
          type="button"
          className={secondary}
          onClick={() =>
            setOverrides([
              ...overrides,
              {
                roomId: units[0]?.id ?? "",
                from: today(),
                to: today(),
                amount: "",
              },
            ])
          }
        >
          ＋新增日期房價
        </button>
        <label className="flex items-start gap-3">
          <input
            className="mt-1"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>
            允許有價格權限的成員在尚未出售清單顯示房價。
            <span className="block text-sm text-slate-500">
              清潔等「不看金額」角色仍收不到房價資料。
            </span>
          </span>
        </label>
        <button className={button}>保存房價設定</button>
      </fieldset>
    </form>
  );
}
export function CustomerSettings({
  initial,
  initialPropertyId,
}: {
  initial: WorkspaceView;
  initialPropertyId?: string;
}) {
  const [checkedAt] = useState(() => Date.now());
  const [data, setData] = useState(initial),
    [panel, setPanel] = useState("properties"),
    [propertyId, setPropertyId] = useState(
      initial.properties.some((p) => p.id === initialPropertyId)
        ? initialPropertyId!
        : (initial.properties[0]?.id ?? ""),
    ),
    [notice, setNotice] = useState("");
  const [members, setMembers] = useState<Members | null>(null),
    [name, setName] = useState(""),
    [kind, setKind] = useState("rooms"),
    [rooms, setRooms] = useState(""),
    [mode, setMode] = useState("sheet"),
    [confirmedEmpty, setConfirmedEmpty] = useState(false);
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<Role>("viewer_no_price"),
    [all, setAll] = useState(false),
    [ids, setIds] = useState<string[]>([]);
  const command = useCommand(
      `/api/customer-workspaces/${data.slug}/operations`,
    ),
    locked = command.busy || command.uncertain;
  const property = data.properties.find((p) => p.id === propertyId);
  useEffect(() => {
    if (panel !== "members" || data.role !== "owner") return;
    api<Members>(
      `/api/customer-workspaces/${data.slug}/operations?view=members`,
    )
      .then((result) => {
        setMembers(result);
        setData((previous) => ({ ...previous, version: result.version }));
      })
      .catch((e) => command.setError(e.message));
    // Loading is tied to the selected panel; writes update the returned state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, data.slug, data.role]);
  async function save(input: Record<string, unknown>) {
    setNotice("");
    const result = await command.execute<Result>({
      ...input,
      version: data.version,
    });
    if (!result) return;
    const value = result.data;
    if (value.workspace) {
      setData(value.workspace);
      if (value.propertyId) setPropertyId(value.propertyId);
    } else if (value.properties && value.role) setData(value as WorkspaceView);
    else if (value.version)
      setData((previous) => ({ ...previous, version: value.version! }));
    if (value.members && value.invitations && value.version)
      setMembers(value as Members);
    if (result.input.action === "property") {
      setName("");
      setRooms("");
      setConfirmedEmpty(false);
      setNotice(
        result.input.mode !== "empty"
          ? "旅宿已建立。請在下方選擇「匯入此館訂單」，完成核對後才會顯示空房。"
          : "旅宿已建立，可開始登記訂房。",
      );
    } else if (result.input.action === "invite") {
      setEmail("");
      setNotice(
        value.delivery === "accepted"
          ? "邀請已保存，寄信服務已接受；成員完成信箱確認後即可加入。"
          : value.delivery === "preview"
            ? "邀請已保存；此預覽環境未實際寄信。"
            : "邀請已保存，但寄送尚待確認。請先核對寄送狀態；需要重寄時，撤回後重新邀請。",
      );
    } else setNotice("已保存並核對結果。");
  }
  async function refresh() {
    try {
      setData(
        await api<WorkspaceView>(`/api/customer-workspaces/${data.slug}`),
      );
      if (panel === "members")
        setMembers(
          await api<Members>(
            `/api/customer-workspaces/${data.slug}/operations?view=members`,
          ),
        );
      command.setError("");
      setNotice("已重新載入，請核對後再操作。");
    } catch (e) {
      command.setError((e as Error).message);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <a href="/workspaces" className="text-sm text-teal-800 underline">
          我的旅宿
        </a>
        <h1 className="mt-3 text-2xl font-semibold">{data.name} · 設定</h1>
        <WorkspaceNav data={data} current="settings" propertyId={propertyId} />
        <div className="my-5 flex flex-wrap gap-2">
          {[
            ["properties", "館別與房間"],
            ...(data.role === "owner" ? [["members", "協作成員"]] : []),
            ["pricing", "房價設定"],
            ...(data.role === "owner" ? [["standard", "標準帳本"]] : []),
          ].map(([value, label]) => (
            <button
              key={value}
              disabled={locked}
              className={panel === value ? button : secondary}
              onClick={() => {
                setPanel(value);
                setNotice("");
              }}
            >
              {label}
            </button>
          ))}
          <button className={secondary} disabled={locked} onClick={refresh}>
            重新載入
          </button>
        </div>
        {command.error && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {command.error}
          </p>
        )}
        {notice && (
          <p role="status" className="my-4 rounded-xl bg-teal-50 p-4">
            {notice}
          </p>
        )}
        {command.uncertain && (
          <div className="my-4 rounded-xl bg-amber-50 p-4">
            <p>結果暫時無法確認，表單已鎖定。重試相同操作會自動避免重複。</p>
            <button
              className={`${button} mt-3`}
              disabled={command.busy}
              onClick={() => void save({})}
            >
              重試相同操作
            </button>
          </div>
        )}
        {panel === "standard" && data.role === "owner" && (
          <StandardSheetPanel slug={data.slug} />
        )}
        {panel === "properties" && (
          <section className="space-y-5">
            <h2 className="text-xl font-semibold">同一帳號下的旅宿</h2>
            <p className="text-sm text-slate-600">
              每間旅宿各自管理房間、訂單與匯入來源。成員只看得到業主開放的館別。
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {data.properties.map((p) => (
                <article className="rounded-2xl border bg-white p-5" key={p.id}>
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="my-2 text-sm">
                    {p.rooms.map((r) => r.name).join("、")}
                  </p>
                  <p className="mb-3 text-sm text-slate-500">
                    {data.readiness?.[p.id]?.complete === false
                      ? "訂單尚待匯入或核對，空房與新增訂房暫停"
                      : "可管理訂房"}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <a
                      className="text-sm underline"
                      href={`/w/${data.slug}/calendar?property=${p.id}`}
                    >
                      開啟此館日曆
                    </a>
                    <a
                      className="text-sm underline"
                      href={`/w/${data.slug}/import?property=${p.id}`}
                    >
                      匯入此館訂單
                    </a>
                  </div>
                </article>
              ))}
            </div>
            {data.role === "owner" && (
              <form
                className="rounded-2xl border bg-white p-5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save({
                    action: "property",
                    name,
                    kind,
                    rooms:
                      kind === "villa" && !rooms.trim()
                        ? ["整棟"]
                        : rooms
                            .split(/[\n,，]/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                    mode,
                    confirmedEmpty,
                  });
                }}
              >
                <fieldset disabled={locked} className="space-y-4">
                  <legend className="mb-3 text-lg font-semibold">
                    新增一間旅宿
                  </legend>
                  <label className="block">
                    旅宿名稱
                    <input
                      className={field}
                      required
                      maxLength={80}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    販售方式
                    <select
                      className={field}
                      value={kind}
                      onChange={(e) => setKind(e.target.value)}
                    >
                      <option value="rooms">逐房販售</option>
                      <option value="villa">只賣整棟</option>
                      <option value="mixed">可逐房，也可包棟</option>
                    </select>
                  </label>
                  <label className="block">
                    實體房間名稱（一行一間）
                    <textarea
                      className={field}
                      required={kind !== "villa"}
                      maxLength={4000}
                      rows={4}
                      placeholder={
                        kind === "villa"
                          ? "若整棟不細分房間，可留空"
                          : "101\n102\n201"
                      }
                      value={rooms}
                      onChange={(e) => setRooms(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    現在的訂單紀錄
                    <select
                      className={field}
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setConfirmedEmpty(false);
                      }}
                    >
                      <option value="sheet">已有試算表，先匯入核對</option>
                      <option value="google_calendar">
                        使用 Google Calendar，先匯入核對
                      </option>
                      <option value="ios_calendar">
                        使用 iOS 日曆，先匯入核對
                      </option>
                      <option value="android_calendar">
                        使用 Android 日曆，先匯入核對
                      </option>
                      <option value="empty">目前沒有有效訂房，直接開始</option>
                    </select>
                  </label>
                  {mode === "empty" && (
                    <label className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        required
                        checked={confirmedEmpty}
                        onChange={(e) => setConfirmedEmpty(e.target.checked)}
                      />
                      <span>
                        我確認此館目前沒有需要保留的有效訂房；已有的電話、平台或紙本訂單要先整理登記。
                      </span>
                    </label>
                  )}
                  <button className={button}>建立旅宿</button>
                </fieldset>
              </form>
            )}
          </section>
        )}
        {panel === "members" && data.role === "owner" && (
          <section className="space-y-5">
            <p className="text-sm leading-6 text-slate-600">
              管家可新增訂房與登記收款；清潔協作建議使用「不看金額」。只有業主能邀請、改權限或停用成員。所有成員都使用自己的信箱與密碼。
            </p>
            <form
              className="rounded-2xl border bg-white p-5"
              onSubmit={(e) => {
                e.preventDefault();
                void save({
                  action: "invite",
                  email,
                  role,
                  allProperties: all,
                  propertyIds: ids,
                });
              }}
            >
              <fieldset disabled={locked} className="space-y-4">
                <legend className="mb-3 font-semibold">邀請協作成員</legend>
                <label className="block">
                  成員 Email
                  <input
                    className={field}
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="block">
                  協作角色
                  <select
                    className={field}
                    value={role}
                    onChange={(e) => setRole(e.target.value as Role)}
                  >
                    {roles.map(([value, label]) => (
                      <option value={value} key={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <ScopeFields
                  properties={data.properties}
                  all={all}
                  ids={ids}
                  onChange={(next, selected) => {
                    setAll(next);
                    setIds(selected);
                  }}
                />
                <button className={button} disabled={!all && !ids.length}>
                  寄出七天有效的邀請
                </button>
              </fieldset>
            </form>
            <h2 className="text-lg font-semibold">目前成員</h2>
            {members?.members.map((member) => (
              <MemberEditor
                key={`${member.accountId}:${members.version}`}
                member={member}
                properties={data.properties}
                locked={locked}
                save={save}
              />
            ))}
            <h2 className="text-lg font-semibold">待接受與過期邀請</h2>
            {members?.invitations
              .filter((i) => !i.acceptedAt)
              .map((i) => (
                <div
                  key={i.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-4"
                >
                  <div>
                    <p>{i.email}</p>
                    <p className="text-sm text-slate-500">
                      {i.revokedAt
                        ? "已撤回"
                        : i.expiresAt <= checkedAt
                          ? "已過期"
                          : "等待接受邀請"}
                    </p>
                  </div>
                  {!i.revokedAt && i.expiresAt > checkedAt ? (
                    <button
                      className={secondary}
                      disabled={locked}
                      onClick={() =>
                        void save({ action: "revoke", invitationId: i.id })
                      }
                    >
                      撤回邀請
                    </button>
                  ) : (
                    <button
                      className={secondary}
                      disabled={locked}
                      onClick={() => {
                        setEmail(i.email);
                        setRole(i.role);
                        setAll(i.allProperties);
                        setIds(i.propertyIds);
                        setNotice("已帶入原邀請內容，請核對上方表單後再寄出。");
                      }}
                    >
                      帶入資料重新邀請
                    </button>
                  )}
                </div>
              ))}
          </section>
        )}
        {panel === "pricing" && (
          <section className="rounded-2xl border bg-white p-5">
            <label className="mb-5 block">
              設定哪間旅宿
              <select
                className={field}
                disabled={locked}
                value={propertyId}
                onChange={(e) => setPropertyId(e.target.value)}
              >
                {data.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {property && (
              <PricingForm
                key={`${property.id}:${data.version}`}
                property={property}
                locked={locked}
                save={save}
              />
            )}
          </section>
        )}
      </div>
    </main>
  );
}
