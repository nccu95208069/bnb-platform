"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
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

const ASSIGNABLE_ROLES: Exclude<WorkspaceRole, "owner">[] = [
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
  const properties = useCalendarPreferences((state) => state.properties);
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
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    void initialize().then(() => refreshMembers());
  }, [initialize, refreshMembers]);

  const sortedMembers = useMemo(
    () =>
      members.slice().sort((a, b) => {
        if (a.role === "owner") return -1;
        if (b.role === "owner") return 1;
        return a.displayName.localeCompare(b.displayName, "zh-TW");
      }),
    [members],
  );

  function beginCreate() {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, propertyIds: properties.map((property) => property.id) });
  }

  function beginEdit(member: WorkspaceMember) {
    if (member.role === "owner") return;
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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
      toast.error("請填寫使用者名稱");
      return;
    }
    if (!form.email.trim() && !form.phone.trim()) {
      toast.error("Email 與手機至少填寫一項");
      return;
    }
    if (!form.allProperties && form.propertyIds.length === 0) {
      toast.error("請至少指定一間旅宿");
      return;
    }

    setSaving(true);
    try {
      await saveMember({ ...form, id: editingId ?? undefined });
      toast.success(editingId ? "成員權限已更新" : "成員已加入", {
        description: "對方使用相同 Email 或手機登入後即可啟用帳號。",
      });
      beginCreate();
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "無法儲存權限");
    } finally {
      setSaving(false);
    }
  }

  async function toggleStatus(member: WorkspaceMember) {
    const nextStatus = member.status === "suspended" ? "invited" : "suspended";
    try {
      await setMemberStatus(member.id, nextStatus);
      toast.success(nextStatus === "suspended" ? "使用者已停用" : "使用者已重新開放");
    } catch (statusError) {
      toast.error(statusError instanceof Error ? statusError.message : "無法更新狀態");
    }
  }

  if (!actorPermissions.manageMembers) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardHeader>
          <CardTitle>沒有權限</CardTitle>
          <CardDescription>只有旅宿擁有者可以管理使用者與角色。</CardDescription>
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
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">權限管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            以 Email 或手機建立帳號，並指定角色與可查看的旅宿。
          </p>
        </div>
        <Button variant="outline" onClick={beginCreate}>
          <Plus className="size-4" />
          新增使用者
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">權限預覽</CardTitle>
          <CardDescription>
            僅供擁有者測試畫面；不會改變你的正式角色。
          </CardDescription>
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
                  {ROLE_DEFINITIONS[role].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm text-muted-foreground">
            目前以「{ROLE_DEFINITIONS[effectiveRole].label}」檢視日曆。
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {editingId ? "編輯使用者" : "新增使用者"}
            </CardTitle>
            <CardDescription>
              使用者登入的 Email 與手機至少需填一項。手機請使用含國碼格式，例如 +886912345678。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="member-name">名稱</Label>
                <Input
                  id="member-name"
                  value={form.displayName}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, displayName: event.target.value }))
                  }
                  placeholder="例如：晚班管家"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="member-email">Email</Label>
                <Input
                  id="member-email"
                  type="email"
                  value={form.email}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, email: event.target.value }))
                  }
                  placeholder="staff@example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="member-phone">手機</Label>
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
                <Label>角色</Label>
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
                        {ROLE_DEFINITIONS[role].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {ROLE_DEFINITIONS[form.role].description}
                </p>
              </div>

              <div className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <Label htmlFor="all-properties">所有旅宿</Label>
                    <p className="text-xs text-muted-foreground">自動包含日後新增的旅宿。</p>
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
                    取消編輯
                  </Button>
                )}
                <Button type="submit" disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {editingId ? "儲存權限" : "加入使用者"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">角色能力</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {ASSIGNABLE_ROLES.map((role) => {
                const definition = ROLE_DEFINITIONS[role];
                return (
                  <div key={role} className="rounded-xl border p-3">
                    <p className="font-semibold">{definition.label}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {definition.description}
                    </p>
                    <div className="mt-2 flex items-center gap-1.5 text-xs">
                      {definition.permissions.viewPrices ? (
                        <Eye className="size-3.5" />
                      ) : (
                        <EyeOff className="size-3.5" />
                      )}
                      {definition.permissions.viewPrices ? "可看價格" : "隱藏價格"}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">使用者</CardTitle>
              <CardDescription>
                {loading ? "正在同步" : `${sortedMembers.length} 位成員`}
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
                      <Badge variant="outline">{ROLE_DEFINITIONS[member.role].label}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {[member.email, member.phone].filter(Boolean).join(" · ") || "目前擁有者"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {member.allProperties
                        ? "所有旅宿"
                        : properties
                            .filter((property) => member.propertyIds.includes(property.id))
                            .map((property) => property.short_name)
                            .join("、") || "未指定旅宿"}
                    </p>
                  </div>

                  {member.role !== "owner" && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => beginEdit(member)}>
                        <Pencil className="size-3.5" />
                        編輯
                      </Button>
                      <Button
                        size="sm"
                        variant={member.status === "suspended" ? "outline" : "ghost"}
                        onClick={() => toggleStatus(member)}
                      >
                        {member.status === "suspended" ? (
                          <UserRoundCheck className="size-3.5" />
                        ) : (
                          <UserRoundX className="size-3.5" />
                        )}
                        {member.status === "suspended" ? "重新開放" : "停用"}
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
