"use client";
import {useT} from "@/components/i18n/language-provider";
import { LoginDevices } from "@/components/account/login-devices";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { toast } from "sonner";

import { useCalendarPreferences } from "@/components/calendar/calendar-preferences";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  ROLE_DEFINITIONS,
  type SaveWorkspaceMemberInput,
  type WorkspaceMember,
  type WorkspaceRole,
  useAccessControl,
  useActorPermissions,
  useEffectiveRole,
} from "@/lib/access-control";
import { cn } from "@/lib/utils";

const ASSIGNABLE_ROLES: Exclude<WorkspaceRole, "owner" | "god">[] = [
  "admin",
  "housekeeper",
  "viewer",
  "viewer_no_price",
];

const EMPTY_FORM: SaveWorkspaceMemberInput = {
  displayName: "",
  email: "",
  phone: "",
  role: "housekeeper",
  allProperties: true,
  propertyIds: [],
};

const LIVE_SHEET = process.env.NEXT_PUBLIC_CALENDAR_SOURCE === "sheet_snapshot";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true" && !LIVE_SHEET;

function statusLabel(status: WorkspaceMember["status"]) {
  if (status === "active") return "已啟用";
  if (status === "suspended") return "已停用";
  return "待啟用";
}

function statusVariant(status: WorkspaceMember["status"]) {
  if (status === "active") return "default" as const;
  if (status === "suspended") return "destructive" as const;
  return "secondary" as const;
}

export default function AccessManagementPage() {
  const uiText = useT();

  const properties = useCalendarPreferences((state) => state.properties);
  const initialized = useAccessControl((state) => state.initialized);
  const mailConfigured = useAccessControl((state) => state.mailConfigured);
  const membership = useAccessControl((state) => state.membership);
  const members = useAccessControl((state) => state.members);
  const loading = useAccessControl((state) => state.loading);
  const error = useAccessControl((state) => state.error);
  const initialize = useAccessControl((state) => state.initialize);
  const refreshMembers = useAccessControl((state) => state.refreshMembers);
  const saveMember = useAccessControl((state) => state.saveMember);
  const setMemberStatus = useAccessControl((state) => state.setMemberStatus);
  const previewRole = useAccessControl((state) => state.previewRole);
  const setPreviewRole = useAccessControl((state) => state.setPreviewRole);
  const actorPermissions = useActorPermissions();
  const effectiveRole = useEffectiveRole();

  const [form, setForm] = useState<SaveWorkspaceMemberInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [recoveryPassword,setRecoveryPassword] = useState("");
  const [recoveryFor,setRecoveryFor] = useState("");
  const [recoveryDraft,setRecoveryDraft] = useState("");
  const [recoveryConfirm,setRecoveryConfirm] = useState("");
  const [recoveryRevision,setRecoveryRevision] = useState<string|null>(null);
  const [recoveryBusy,setRecoveryBusy] = useState(false);
  const [deviceAccount,setDeviceAccount] = useState<string|null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const formCardRef = useRef<HTMLDivElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    if (membership?.role === "owner" || membership?.role === "admin" || membership?.role === "god") void refreshMembers();
  }, [membership?.id, membership?.role, refreshMembers]);

  const sortedMembers = useMemo(
    () =>
      members.slice().sort((a, b) => {
        if (a.role === "owner") return -1;
        if (b.role === "owner") return 1;
        return a.displayName.localeCompare(b.displayName, "zh-TW");
      }),
    [members],
  );

  function resetForm() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, propertyIds: properties.map((property) => property.id) });
  }

  function focusForm() {
    // Keep focus inside the tap handler so iOS can open its keyboard.
    nameInputRef.current?.focus({ preventScroll: true });
    formCardRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  }

  function beginCreate() {
    resetForm();
    focusForm();
  }

  function beginEdit(member: WorkspaceMember) {
    if (member.role === "owner" || member.role === "god") return;
    setEditingId(member.id);
    setForm({
      id: member.id,
      displayName: member.displayName,
      email: member.email ?? "",
      phone: member.phone ?? "",
      role: member.role,
      allProperties: member.allProperties,
      propertyIds: member.propertyIds,
    });
    focusForm();
  }

  function toggleProperty(propertyId: string) {
    setForm((current) => ({
      ...current,
      propertyIds: current.propertyIds.includes(propertyId)
        ? current.propertyIds.filter((id) => id !== propertyId)
        : [...current.propertyIds, propertyId],
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.displayName.trim()) {
      toast.error(uiText("請填寫使用者名稱"));
      return;
    }
    if ((LIVE_SHEET && !form.email.trim()) || (!form.email.trim() && !form.phone.trim())) {
      toast.error(uiText(LIVE_SHEET ? "請填寫接收邀請信的 Email" : "Email 與手機至少填寫一項"));
      return;
    }
    if (!form.allProperties && form.propertyIds.length === 0) {
      toast.error(uiText("請至少指定一間旅宿"));
      return;
    }

    setSaving(true);
    try {
      await saveMember({ ...form, id: editingId ?? undefined });
      toast.success(uiText(editingId ? "成員權限已更新" : LIVE_SHEET ? "邀請信已寄出" : "成員已加入"), {
        description: DEMO_MODE
          ? "已儲存在此瀏覽器供測試，尚未建立正式登入帳號。"
          : "請對方從邀請信設定密碼，再用 Email 與密碼登入。",
      });
      resetForm();
    } catch (saveError) {
      toast.error(uiText(saveError instanceof Error ? saveError.message : "無法儲存權限"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(member: WorkspaceMember) {
    const nextStatus = member.status === "suspended" ? "invited" : "suspended";
    try {
      await setMemberStatus(member.id, nextStatus);
      toast.success(uiText(nextStatus === "suspended" ? "使用者已停用" : "使用者已重新開放"));
    } catch (statusError) {
      toast.error(uiText(statusError instanceof Error ? statusError.message : "無法更新狀態"));
    }
  }

  if (!initialized) return <p className="p-5">{uiText("正在確認管理者登入…")}</p>;
  if (!actorPermissions.manageMembers) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>{uiText("沒有權限")}</CardTitle>
          <CardDescription>{uiText("只有旅宿擁有者可以管理使用者與角色。")}</CardDescription><a href="/calendar-access" className="underline">{uiText("前往登入")}</a>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-5 pb-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <ShieldCheck className="size-4" />
            {membership?.tenantName ?? "Sweetfun OS"}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{uiText("權限管理")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {DEMO_MODE
              ? uiText("目前為權限示範：資料只儲存在此瀏覽器，不會建立正式登入帳號。")
              : uiText("以 Email 寄送邀請，由成員自行設定密碼，並指定可查看的旅宿。")}
          </p>
        </div>
        <Button variant="outline" onClick={beginCreate} aria-controls="member-form-card">
          <Plus className="size-4" />
          {uiText("新增使用者")}</Button>
      </div>

      {LIVE_SHEET && <div className="rounded-xl border bg-card p-4 text-sm leading-6">
        <p>{uiText("擁有者：sweetfuntw@gmail.com · 沿用你設定的私人密碼。")}</p>
        <p>{uiText("目前訂房表為唯讀，所有角色都不能修改正式訂單或收款。")}</p>
        <p>{mailConfigured ? uiText("Gmail 已連接，新增成員會寄送邀請信。") : uiText("尚未完成 Gmail 寄信授權，完成後才能新增成員。")} <a href="/settings/email" className="underline">{uiText("寄信設定")}</a></p>
        <p className="text-muted-foreground">{uiText("舊的測試成員已從此瀏覽器清除。下方只列正式帳號。")}</p>
      </div>}
      {LIVE_SHEET && <Card><CardHeader><CardTitle className="text-base">{uiText("忘記密碼 · 管理員協助")}</CardTitle><CardDescription>{uiText("所有帳號共用固定臨時密碼。先對指定成員按「啟用臨時密碼」，再把密碼交給對方；對方須設定新密碼後才能進入日曆。")}</CardDescription></CardHeader><CardContent className="space-y-3">
        <Button variant="outline" disabled={recoveryBusy} onClick={async()=>{try{const r=await fetch('/api/workspace-recovery',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.detail);setRecoveryPassword(d.password);setRecoveryFor('');}catch(e){toast.error(uiText(e instanceof Error?e.message:'無法讀取'));}}}>{uiText("查看固定臨時密碼")}</Button>
        <Button variant="outline" disabled={recoveryBusy} onClick={async()=>{setRecoveryBusy(true);try{const r=await fetch('/api/workspace-recovery',{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.detail);setRecoveryRevision(d.revision);setRecoveryDraft('');setRecoveryConfirm('');}catch(e){toast.error(uiText(e instanceof Error?e.message:'無法讀取'));}finally{setRecoveryBusy(false);}}}>{uiText("設定共用臨時密碼")}</Button>
        {recoveryRevision && <form className="space-y-3 rounded-lg border p-3" onSubmit={async e=>{e.preventDefault();setRecoveryBusy(true);try{const r=await fetch('/api/workspace-recovery',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:recoveryDraft,confirmPassword:recoveryConfirm,revision:recoveryRevision})});const d=await r.json();if(!r.ok)throw new Error(d.detail);setRecoveryPassword(d.password);setRecoveryFor('');setRecoveryDraft('');setRecoveryConfirm('');setRecoveryRevision(null);await refreshMembers();toast.success(uiText(`共用臨時密碼已儲存${d.updatedCount?`，${d.updatedCount} 位待重設成員已改用新臨時密碼`:''}`));}catch(e){toast.error(uiText(e instanceof Error?e.message:'儲存失敗'));}finally{setRecoveryBusy(false);}}}>
          <p className="text-sm leading-6">{uiText("自行設定一組 12～128 個字元的臨時密碼，儲存後會一直沿用。已啟用重設的成員也會改用這組，尚未完成重設的舊登入會失效；其他成員的個人密碼不變。")}</p>
          <label className="block text-sm">{uiText("共用臨時密碼")}<input aria-label={uiText("共用臨時密碼")} type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={recoveryDraft} onChange={e=>setRecoveryDraft(e.target.value)} className="mt-2 w-full rounded-lg border p-3" /></label>
          <label className="block text-sm">{uiText("再次輸入臨時密碼")}<input aria-label={uiText("再次輸入臨時密碼")} type="password" autoComplete="new-password" required value={recoveryConfirm} onChange={e=>setRecoveryConfirm(e.target.value)} className="mt-2 w-full rounded-lg border p-3" /></label>
          <div className="flex gap-2"><Button disabled={recoveryBusy} type="submit">{recoveryBusy?uiText("儲存中…"):uiText("儲存臨時密碼")}</Button><Button type="button" variant="outline" disabled={recoveryBusy} onClick={()=>{setRecoveryRevision(null);setRecoveryDraft('');setRecoveryConfirm('');}}>{uiText("取消")}</Button></div>
        </form>}
        {recoveryPassword && <div className="space-y-2 rounded-lg border p-3"><p className="text-sm">{recoveryFor?uiText("{0} 已啟用重設，原密碼及舊登入已失效。", [recoveryFor]):uiText("只有已啟用重設的帳號能使用此密碼。")}</p><code className="block break-all select-all text-base">{recoveryPassword}</code><Button variant="outline" size="sm" onClick={async()=>{try{await navigator.clipboard.writeText(recoveryPassword);toast.success(uiText('已複製'));}catch{toast.error(uiText('請長按密碼複製'));}}}>{uiText("複製臨時密碼")}</Button></div>}
      </CardContent></Card>}
      {deviceAccount && <div><Button variant="ghost" onClick={()=>setDeviceAccount(null)}>{uiText("關閉裝置紀錄")}</Button><LoginDevices key={deviceAccount} accountId={deviceAccount}/></div>}
      {membership?.role === "owner" && <Card>
        <CardHeader>
          <CardTitle className="text-base">{uiText("權限預覽")}</CardTitle>
          <CardDescription>
            {uiText("僅供擁有者暫時測試畫面；不會改變正式角色。重新整理或重新登入會恢復管理員檢視。")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Select
            value={previewRole ?? "owner"}
            onValueChange={(value) =>
              setPreviewRole(value === "owner" ? null : (value as WorkspaceRole))
            }
          >
            <SelectTrigger className="sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ROLE_DEFINITIONS) as WorkspaceRole[]).map((role) => (
                <SelectItem key={role} value={role}>
                  {uiText(ROLE_DEFINITIONS[role].label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            {uiText("目前以「")}{uiText(ROLE_DEFINITIONS[effectiveRole].label)}{uiText("」檢視日曆。")}</p>
        </CardContent>
      </Card>}

      <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Card id="member-form-card" ref={formCardRef} className="scroll-mt-16 md:scroll-mt-6">
          <CardHeader>
            <CardTitle className="text-base">
              {editingId ? uiText("編輯使用者") : uiText("新增使用者")}
            </CardTitle>
            <CardDescription>
              {LIVE_SHEET ? uiText("請填寫成員的 Email。邀請連結 24 小時有效，由本人設定密碼。手機僅供聯絡。") : uiText("使用者登入的 Email 與手機至少需填一項。手機請使用含國碼格式，例如 +886912345678。")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="member-name">{uiText("名稱")}</Label>
                <Input
                  id="member-name"
                  ref={nameInputRef}
                  value={form.displayName}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder={uiText("例如：晚班管家")}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="member-email">Email</Label>
                <Input
                  id="member-email"
                  disabled={LIVE_SHEET && Boolean(editingId)}
                  required={LIVE_SHEET}
                  type="email"
                  value={form.email}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, email: event.target.value }))
                  }
                  placeholder="staff@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="member-phone">{uiText("手機")}</Label>
                <Input
                  id="member-phone"
                  type="tel"
                  value={form.phone}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, phone: event.target.value }))
                  }
                  placeholder="+886912345678"
                />
              </div>

              <div className="space-y-2">
                <Label>{uiText("角色")}</Label>
                <Select
                  value={form.role}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      role: value as SaveWorkspaceMemberInput["role"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSIGNABLE_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {uiText(ROLE_DEFINITIONS[role].label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {uiText(ROLE_DEFINITIONS[form.role].description)}
                </p>
              </div>

              <div className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="all-properties">{uiText("所有旅宿")}</Label>
                    <p className="text-xs text-muted-foreground">{uiText("自動包含日後新增的旅宿。")}</p>
                  </div>
                  <Switch
                    id="all-properties"
                    checked={form.allProperties}
                    onCheckedChange={(checked) =>
                      setForm((current) => ({
                        ...current,
                        allProperties: checked,
                        propertyIds: checked
                          ? properties.map((property) => property.id)
                          : current.propertyIds,
                      }))
                    }
                  />
                </div>

                {!form.allProperties && (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    {properties.map((property) => {
                      const selected = form.propertyIds.includes(property.id);
                      return (
                        <button
                          key={property.id}
                          type="button"
                          onClick={() => toggleProperty(property.id)}
                          className={cn(
                            "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm",
                            selected ? "border-primary bg-primary/5" : "text-muted-foreground",
                          )}
                        >
                          <span
                            className={cn(
                              "flex size-5 items-center justify-center rounded border",
                              selected && "border-primary bg-primary text-primary-foreground",
                            )}
                          >
                            {selected && <UserRoundCheck className="size-3" />}
                          </span>
                          {property.short_name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2">
                {editingId && (
                  <Button type="button" variant="outline" onClick={beginCreate}>
                    {uiText("取消編輯")}</Button>
                )}
                <Button type="submit" disabled={saving || (LIVE_SHEET && !editingId && !mailConfigured)}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {editingId ? uiText("儲存權限") : LIVE_SHEET ? uiText("寄送邀請信") : uiText("加入使用者")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{uiText("角色能力")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {ASSIGNABLE_ROLES.map((role) => {
                const definition = ROLE_DEFINITIONS[role];
                return (
                  <div key={role} className="rounded-xl border p-3">
                    <p className="font-semibold">{uiText(definition.label)}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {uiText(definition.description)}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5 text-xs">
                      {definition.permissions.viewPrices ? (
                        <Eye className="size-3.5" />
                      ) : (
                        <EyeOff className="size-3.5" />
                      )}
                      {definition.permissions.viewPrices ? uiText("可看價格") : uiText("隱藏價格")}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{uiText("使用者")}</CardTitle>
              <CardDescription>
                {loading ? uiText("正在同步") : uiText("{0} 位成員", [sortedMembers.length])}
                {error ? ` · ${error}` : ""}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {sortedMembers.map((member) => (
                <div
                  key={member.id}
                  className="flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{member.displayName}</p>
                      <Badge variant={statusVariant(member.status)}>
                        {statusLabel(member.status)}
                      </Badge>
                      <Badge variant="outline">{uiText(ROLE_DEFINITIONS[member.role].label)}</Badge>
                      {member.mustResetPassword && <Badge variant="secondary">{uiText("待設定新密碼")}</Badge>}
                      {member.invitationStatus && <Badge variant={member.invitationStatus === "failed" ? "destructive" : "secondary"}>{member.invitationStatus === "sent" ? uiText("邀請信已寄出") : member.invitationStatus === "failed" ? uiText("邀請信未確認寄出") : uiText("邀請處理中")}</Badge>}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {[member.email, member.phone].filter(Boolean).join(" · ") || "目前擁有者"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {member.allProperties
                        ? uiText("所有旅宿")
                        : properties
                            .filter((property) => member.propertyIds.includes(property.id))
                            .map((property) => property.short_name)
                            .join("、") || "未指定旅宿"}
                    </p>
                  </div>

                  {member.role !== "owner" && member.role !== "god" && (
                    <div className="flex flex-wrap gap-2">
                      {LIVE_SHEET && member.status !== "suspended" && <Button size="sm" variant="outline" disabled={recoveryBusy} onClick={async()=>{
                        setRecoveryBusy(true);try{const r=await fetch('/api/workspace-recovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:member.id,version:member.version})});const d=await r.json();if(!r.ok)throw new Error(d.detail);setRecoveryPassword(d.password);setRecoveryFor(member.displayName);await refreshMembers();toast.success(uiText('已啟用臨時密碼，請到上方複製並交給成員'));}catch(e){toast.error(uiText(e instanceof Error?e.message:'無法重設'));}finally{setRecoveryBusy(false);}
                      }}>{uiText("啟用臨時密碼")}</Button>}
                      {LIVE_SHEET && <Button size="sm" variant="outline" onClick={()=>setDeviceAccount(member.id)}>{uiText("登入裝置")}</Button>}
                      <Button size="sm" variant="outline" onClick={() => beginEdit(member)}>
                        <Pencil className="size-3.5" />
                        {uiText("編輯")}</Button>
                      <Button
                        size="sm"
                        variant={member.status === "suspended" ? "outline" : "ghost"}
                        disabled={membership?.role !== "owner" && membership?.role !== "god" && member.role === "admin"}
                        onClick={() => toggleStatus(member)}
                      >
                        {member.status === "suspended" ? (
                          <UserRoundCheck className="size-3.5" />
                        ) : (
                          <UserRoundX className="size-3.5" />
                        )}
                        {member.status === "suspended" ? uiText("重新開放") : uiText("停用")}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
