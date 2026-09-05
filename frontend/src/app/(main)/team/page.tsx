"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
  UserCog,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";

import { useAccess } from "@/components/access/access-provider";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  normalizeTaiwanPhone,
  permissionsForRole,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
} from "@/lib/access-control";
import { supabase } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const DEMO_TEAM_KEY = "sweetfun-os-demo-team-v1";

type PropertyOption = { id: string; name: string };

type MemberFormValue = {
  displayName: string;
  email: string;
  phone: string;
  role: Exclude<WorkspaceRole, "owner">;
  allProperties: boolean;
  propertyIds: string[];
};

const DEMO_PROPERTIES: PropertyOption[] = [
  { id: "sweetfun", name: "水芳 Sweetfun" },
  { id: "offland", name: "遺忘無際 Offland" },
];

const DEMO_OWNER: WorkspaceMember = {
  id: "demo-owner",
  display_name: "羅偉哲",
  email: "demo-owner@sweetfun.local",
  phone: null,
  role: "owner",
  status: "active",
  all_properties: true,
  property_ids: DEMO_PROPERTIES.map((property) => property.id),
  permissions: permissionsForRole("owner"),
};

const ASSIGNABLE_ROLES: Exclude<WorkspaceRole, "owner">[] = [
  "admin",
  "housekeeper",
  "viewer",
  "viewer_no_price",
];

function MemberDialog({
  open,
  member,
  properties,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  member: WorkspaceMember | null;
  properties: PropertyOption[];
  onOpenChange: (open: boolean) => void;
  onSave: (value: MemberFormValue) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(member?.display_name ?? "");
  const [email, setEmail] = useState(member?.email ?? "");
  const [phone, setPhone] = useState(member?.phone ?? "");
  const [role, setRole] = useState<Exclude<WorkspaceRole, "owner">>(
    member?.role && member.role !== "owner" ? member.role : "housekeeper",
  );
  const [allProperties, setAllProperties] = useState(member?.all_properties ?? true);
  const [propertyIds, setPropertyIds] = useState<string[]>(
    member?.property_ids ?? properties.map((property) => property.id),
  );
  const [saving, setSaving] = useState(false);
  const hasIdentity = Boolean(email.trim() || phone.trim());
  const propertyScopeValid = allProperties || propertyIds.length > 0;
  const valid = Boolean(displayName.trim() && hasIdentity && propertyScopeValid);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await onSave({
        displayName: displayName.trim(),
        email: email.trim().toLowerCase(),
        phone: normalizeTaiwanPhone(phone),
        role,
        allProperties,
        propertyIds: allProperties ? properties.map((property) => property.id) : propertyIds,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{member ? "修改成員權限" : "新增成員"}</DialogTitle>
          <DialogDescription>
            成員使用相同 Email 或手機登入後，系統會自動認領這筆授權。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="member-name">姓名／顯示名稱</Label>
            <Input
              id="member-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="例如：林管家"
              required
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="member-email">Email</Label>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="name@example.com"
                disabled={Boolean(member)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="member-phone">手機</Label>
              <Input
                id="member-phone"
                inputMode="tel"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="0912 345 678"
                disabled={Boolean(member)}
              />
            </div>
          </div>
          {!hasIdentity && (
            <p className="text-xs text-destructive">Email 與手機至少填一項。</p>
          )}
          <div className="space-y-2">
            <Label>權限等級</Label>
            <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {ROLE_LABELS[option]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs leading-5 text-muted-foreground">
              {ROLE_DESCRIPTIONS[role]}
            </p>
          </div>
          <div className="space-y-2">
            <Label>可查看的旅宿</Label>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm">
              <input
                type="checkbox"
                checked={allProperties}
                onChange={(event) => setAllProperties(event.target.checked)}
                className="size-4"
              />
              <span>
                <span className="block font-medium">全部旅宿</span>
                <span className="text-xs text-muted-foreground">新旅宿建立後也自動納入。</span>
              </span>
            </label>
            {!allProperties && (
              <div className="grid gap-2 sm:grid-cols-2">
                {properties.map((property) => {
                  const checked = propertyIds.includes(property.id);
                  return (
                    <label
                      key={property.id}
                      className="flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPropertyIds((current) =>
                            checked
                              ? current.filter((id) => id !== property.id)
                              : [...current, property.id],
                          )
                        }
                        className="size-4"
                      />
                      {property.name}
                    </label>
                  );
                })}
              </div>
            )}
            {!propertyScopeValid && (
              <p className="text-xs text-destructive">請至少選擇一間旅宿。</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={!valid || saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              儲存權限
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RoleSummary({ role }: { role: Exclude<WorkspaceRole, "owner"> }) {
  const permissions = permissionsForRole(role);
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex items-center gap-2">
        {role === "viewer_no_price" ? (
          <EyeOff className="size-4 text-muted-foreground" />
        ) : role === "viewer" ? (
          <Eye className="size-4 text-muted-foreground" />
        ) : role === "admin" ? (
          <ShieldCheck className="size-4 text-muted-foreground" />
        ) : (
          <UserCog className="size-4 text-muted-foreground" />
        )}
        <h3 className="font-semibold">{ROLE_LABELS[role]}</h3>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{ROLE_DESCRIPTIONS[role]}</p>
      <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
        {permissions.edit_bookings && <span className="rounded-full bg-muted px-2 py-1">可改訂單</span>}
        {permissions.record_payments && <span className="rounded-full bg-muted px-2 py-1">可登記付款</span>}
        {permissions.cancel_bookings && <span className="rounded-full bg-muted px-2 py-1">可取消</span>}
        {permissions.view_prices ? (
          <span className="rounded-full bg-muted px-2 py-1">可看價格</span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-800">隱藏價格</span>
        )}
      </div>
    </div>
  );
}

export default function TeamPage() {
  const { membership, permissions } = useAccess();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [properties, setProperties] = useState<PropertyOption[]>(DEMO_PROPERTIES);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKey, setDialogKey] = useState(0);
  const [editingMember, setEditingMember] = useState<WorkspaceMember | null>(null);

  const load = useCallback(async () => {
    if (!membership) return;
    setLoading(true);
    try {
      if (DEMO_MODE) {
        const stored = window.localStorage.getItem(DEMO_TEAM_KEY);
        const demoMembers = stored ? (JSON.parse(stored) as WorkspaceMember[]) : [DEMO_OWNER];
        setMembers(demoMembers.some((member) => member.role === "owner") ? demoMembers : [DEMO_OWNER, ...demoMembers]);
        setProperties(DEMO_PROPERTIES);
        return;
      }

      const [{ data: memberData, error: memberError }, { data: propertyData, error: propertyError }] =
        await Promise.all([
          supabase.rpc("list_workspace_members", { p_tenant_id: membership.tenant_id }),
          supabase.rpc("list_workspace_properties", { p_tenant_id: membership.tenant_id }),
        ]);
      if (memberError) throw memberError;
      if (propertyError) throw propertyError;
      setMembers((memberData ?? []) as WorkspaceMember[]);
      setProperties((propertyData ?? []) as PropertyOption[]);
    } catch (error) {
      toast.error("無法讀取成員權限", {
        description: error instanceof Error ? error.message : "請稍後再試。",
      });
    } finally {
      setLoading(false);
    }
  }, [membership]);

  useEffect(() => {
    void load();
  }, [load]);

  const propertyName = useMemo(
    () => new Map(properties.map((property) => [property.id, property.name])),
    [properties],
  );

  function persistDemo(nextMembers: WorkspaceMember[]) {
    setMembers(nextMembers);
    window.localStorage.setItem(DEMO_TEAM_KEY, JSON.stringify(nextMembers));
  }

  async function saveMember(value: MemberFormValue) {
    if (!membership) return;
    try {
      if (DEMO_MODE) {
        const nextMember: WorkspaceMember = {
          id: editingMember?.id ?? `demo-member-${crypto.randomUUID()}`,
          display_name: value.displayName,
          email: value.email || null,
          phone: value.phone || null,
          role: value.role,
          status: editingMember?.status ?? "invited",
          all_properties: value.allProperties,
          property_ids: value.propertyIds,
          permissions: permissionsForRole(value.role),
          invited_at: editingMember?.invited_at ?? new Date().toISOString(),
          accepted_at: editingMember?.accepted_at ?? null,
        };
        persistDemo(
          editingMember
            ? members.map((member) => (member.id === editingMember.id ? nextMember : member))
            : [...members, nextMember],
        );
      } else {
        const { error } = await supabase.rpc("upsert_workspace_member", {
          p_tenant_id: membership.tenant_id,
          p_display_name: value.displayName,
          p_email: value.email || null,
          p_phone_e164: value.phone || null,
          p_role: value.role,
          p_all_properties: value.allProperties,
          p_property_ids: value.propertyIds,
        });
        if (error) throw error;
        await load();
      }
      toast.success(editingMember ? "成員權限已更新" : "成員權限已建立");
    } catch (error) {
      toast.error("無法儲存權限", {
        description: error instanceof Error ? error.message : "請稍後再試。",
      });
      throw error;
    }
  }

  async function changeStatus(member: WorkspaceMember, status: WorkspaceMemberStatus) {
    try {
      if (DEMO_MODE) {
        persistDemo(
          members.map((item) => (item.id === member.id ? { ...item, status } : item)),
        );
      } else {
        const { error } = await supabase.rpc("set_workspace_member_status", {
          p_member_id: member.id,
          p_status: status,
        });
        if (error) throw error;
        await load();
      }
      toast.success(status === "suspended" ? "已停用成員" : "已恢復成員");
    } catch (error) {
      toast.error("無法修改成員狀態", {
        description: error instanceof Error ? error.message : "請稍後再試。",
      });
    }
  }

  if (!permissions.manage_members) {
    return (
      <div className="rounded-2xl border bg-card p-8 text-center shadow-sm">
        <ShieldCheck className="mx-auto size-9 text-muted-foreground" />
        <h1 className="mt-3 text-xl font-semibold">只有管理者可以管理成員</h1>
        <p className="mt-2 text-sm text-muted-foreground">目前帳號仍可依既有權限使用訂單與房況功能。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 pb-8">
      <section className="flex flex-col gap-4 rounded-2xl border bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <UsersRound className="size-4" />
            {membership?.tenant_name}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">成員與權限</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            以 Email 或手機建立帳號授權，並限制角色及可查看的旅宿。
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingMember(null);
            setDialogKey((value) => value + 1);
            setDialogOpen(true);
          }}
        >
          <UserPlus className="size-4" />
          新增成員
        </Button>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {ASSIGNABLE_ROLES.map((role) => (
          <RoleSummary key={role} role={role} />
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="font-semibold">工作區成員</h2>
            <p className="text-xs text-muted-foreground">管理者權限不能由其他成員修改或刪除。</p>
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{members.length} 人</span>
        </div>
        {loading ? (
          <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            讀取成員中
          </div>
        ) : (
          <div className="divide-y">
            {members.map((member) => (
              <div key={member.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold">{member.display_name}</p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium">
                      {ROLE_LABELS[member.role]}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[11px] font-medium",
                        member.status === "active"
                          ? "bg-emerald-50 text-emerald-700"
                          : member.status === "suspended"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-amber-50 text-amber-700",
                      )}
                    >
                      {member.status === "active" ? "使用中" : member.status === "suspended" ? "已停用" : "等待首次登入"}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {[member.email, member.phone].filter(Boolean).join(" · ") || "尚無登入識別"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {member.all_properties
                      ? "全部旅宿"
                      : member.property_ids.map((id) => propertyName.get(id) ?? id).join("、")}
                  </p>
                </div>
                {member.role !== "owner" && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingMember(member);
                        setDialogKey((value) => value + 1);
                        setDialogOpen(true);
                      }}
                    >
                      修改權限
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void changeStatus(
                          member,
                          member.status === "suspended" ? "invited" : "suspended",
                        )
                      }
                    >
                      {member.status === "suspended" ? "恢復" : "停用"}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <MemberDialog
        key={`${dialogKey}-${editingMember?.id ?? "new"}`}
        open={dialogOpen}
        member={editingMember}
        properties={properties}
        onOpenChange={setDialogOpen}
        onSave={saveMember}
      />
    </div>
  );
}
