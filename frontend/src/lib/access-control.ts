export type WorkspaceRole =
  | "owner"
  | "admin"
  | "housekeeper"
  | "viewer"
  | "viewer_no_price";

export type WorkspaceMemberStatus = "invited" | "active" | "suspended";

export type WorkspacePermissions = {
  manage_members: boolean;
  edit_bookings: boolean;
  record_payments: boolean;
  cancel_bookings: boolean;
  view_prices: boolean;
};

export type WorkspaceMembership = {
  id: string;
  tenant_id: string;
  tenant_name: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  all_properties: boolean;
  property_ids: string[];
  permissions: WorkspacePermissions;
};

export type WorkspaceMember = {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  all_properties: boolean;
  property_ids: string[];
  permissions: WorkspacePermissions;
  invited_at?: string | null;
  accepted_at?: string | null;
  last_active_at?: string | null;
};

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "管理者",
  admin: "Admin",
  housekeeper: "管家",
  viewer: "唯讀",
  viewer_no_price: "唯讀（隱藏價格）",
};

export const ROLE_DESCRIPTIONS: Record<WorkspaceRole, string> = {
  owner: "管理所有成員、訂單、付款、取消與價格資訊。",
  admin: "可修改訂單、登記付款與取消預訂，但不能管理成員。",
  housekeeper: "可修改入住資訊與登記付款，不能取消預訂或管理成員。",
  viewer: "只能查看訂單、房況與價格。",
  viewer_no_price: "只能查看訂單與房況，房費、訂金與付款紀錄均隱藏。",
};

export function permissionsForRole(role: WorkspaceRole): WorkspacePermissions {
  return {
    manage_members: role === "owner",
    edit_bookings: role === "owner" || role === "admin" || role === "housekeeper",
    record_payments: role === "owner" || role === "admin" || role === "housekeeper",
    cancel_bookings: role === "owner" || role === "admin",
    view_prices: role !== "viewer_no_price",
  };
}

export const DEMO_MEMBERSHIP: WorkspaceMembership = {
  id: "demo-owner",
  tenant_id: "9c2ac572-483a-4aa5-9193-1f8e11648ccf",
  tenant_name: "Sweetfun 水芳",
  display_name: "羅偉哲",
  email: "demo-owner@sweetfun.local",
  phone: null,
  role: "owner",
  status: "active",
  all_properties: true,
  property_ids: ["sweetfun", "offland"],
  permissions: permissionsForRole("owner"),
};

export function normalizeTaiwanPhone(value: string): string {
  const compact = value.replace(/[\s()-]/g, "");
  if (!compact) return "";
  if (compact.startsWith("+")) return compact;
  if (compact.startsWith("886")) return `+${compact}`;
  if (/^09\d{8}$/.test(compact)) return `+886${compact.slice(1)}`;
  return compact;
}

export function maskMoney(value: number | null | undefined, canViewPrices: boolean): number | null {
  if (!canViewPrices) return null;
  return typeof value === "number" ? value : null;
}
