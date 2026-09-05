"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { supabase } from "@/lib/supabase/client";

export type WorkspaceRole =
  | "owner"
  | "admin"
  | "housekeeper"
  | "viewer"
  | "viewer_no_price";

export type WorkspaceMemberStatus = "invited" | "active" | "suspended";

export type RolePermissions = {
  manageMembers: boolean;
  editBookings: boolean;
  recordPayments: boolean;
  cancelBookings: boolean;
  viewPrices: boolean;
};

export type AccessMembership = {
  id: string;
  tenantId: string;
  tenantName: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  allProperties: boolean;
  propertyIds: string[];
};

export type WorkspaceMember = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  allProperties: boolean;
  propertyIds: string[];
  invitedAt: string;
  acceptedAt: string | null;
  lastActiveAt: string | null;
};

export type SaveWorkspaceMemberInput = {
  id?: string;
  displayName: string;
  email: string;
  phone: string;
  role: Exclude<WorkspaceRole, "owner">;
  allProperties: boolean;
  propertyIds: string[];
};

export const ROLE_DEFINITIONS: Record<
  WorkspaceRole,
  { label: string; description: string; permissions: RolePermissions }
> = {
  owner: {
    label: "擁有者",
    description: "管理所有旅宿、訂單、款項與成員權限。",
    permissions: {
      manageMembers: true,
      editBookings: true,
      recordPayments: true,
      cancelBookings: true,
      viewPrices: true,
    },
  },
  admin: {
    label: "Admin",
    description: "可管理訂單、款項與取消，但不能變更成員權限。",
    permissions: {
      manageMembers: false,
      editBookings: true,
      recordPayments: true,
      cancelBookings: true,
      viewPrices: true,
    },
  },
  housekeeper: {
    label: "管家",
    description: "可更新入住資料、需求與收款，不可取消訂單或管理成員。",
    permissions: {
      manageMembers: false,
      editBookings: true,
      recordPayments: true,
      cancelBookings: false,
      viewPrices: true,
    },
  },
  viewer: {
    label: "唯讀",
    description: "可查看完整訂單與價格，不可修改。",
    permissions: {
      manageMembers: false,
      editBookings: false,
      recordPayments: false,
      cancelBookings: false,
      viewPrices: true,
    },
  },
  viewer_no_price: {
    label: "唯讀（隱藏價格）",
    description: "可查看房況與入住需求，但不會取得任何價格或付款金額。",
    permissions: {
      manageMembers: false,
      editBookings: false,
      recordPayments: false,
      cancelBookings: false,
      viewPrices: false,
    },
  },
};

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const DEMO_TENANT_ID = "demo-sweetfun-workspace";

const DEMO_OWNER: AccessMembership = {
  id: "demo-owner",
  tenantId: DEMO_TENANT_ID,
  tenantName: "Sweetfun 水芳",
  displayName: "Owner",
  email: null,
  phone: null,
  role: "owner",
  status: "active",
  allProperties: true,
  propertyIds: ["sweetfun", "offland"],
};

const DEFAULT_DEMO_MEMBERS: WorkspaceMember[] = [
  {
    id: "demo-owner",
    displayName: "Owner",
    email: null,
    phone: null,
    role: "owner",
    status: "active",
    allProperties: true,
    propertyIds: ["sweetfun", "offland"],
    invitedAt: "2026-09-05T00:00:00+08:00",
    acceptedAt: "2026-09-05T00:00:00+08:00",
    lastActiveAt: null,
  },
];

type RpcMembership = {
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
};

type RpcMember = {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  role: WorkspaceRole;
  status: WorkspaceMemberStatus;
  all_properties: boolean;
  property_ids: string[];
  invited_at: string;
  accepted_at: string | null;
  last_active_at: string | null;
};

function mapMembership(value: RpcMembership): AccessMembership {
  return {
    id: value.id,
    tenantId: value.tenant_id,
    tenantName: value.tenant_name,
    displayName: value.display_name,
    email: value.email,
    phone: value.phone,
    role: value.role,
    status: value.status,
    allProperties: value.all_properties,
    propertyIds: value.property_ids ?? [],
  };
}

function mapMember(value: RpcMember): WorkspaceMember {
  return {
    id: value.id,
    displayName: value.display_name,
    email: value.email,
    phone: value.phone,
    role: value.role,
    status: value.status,
    allProperties: value.all_properties,
    propertyIds: value.property_ids ?? [],
    invitedAt: value.invited_at,
    acceptedAt: value.accepted_at,
    lastActiveAt: value.last_active_at,
  };
}

function demoId() {
  return `demo-member-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

type AccessControlState = {
  initialized: boolean;
  loading: boolean;
  error: string | null;
  membership: AccessMembership | null;
  previewRole: WorkspaceRole | null;
  members: WorkspaceMember[];
  initialize: () => Promise<void>;
  refreshMembers: () => Promise<void>;
  saveMember: (input: SaveWorkspaceMemberInput) => Promise<void>;
  setMemberStatus: (memberId: string, status: WorkspaceMemberStatus) => Promise<void>;
  setPreviewRole: (role: WorkspaceRole | null) => void;
  reset: () => void;
};

export const useAccessControl = create<AccessControlState>()(
  persist(
    (set, get) => ({
      initialized: false,
      loading: false,
      error: null,
      membership: DEMO_MODE ? DEMO_OWNER : null,
      previewRole: null,
      members: DEMO_MODE ? DEFAULT_DEMO_MEMBERS : [],

      initialize: async () => {
        if (get().initialized) return;
        if (DEMO_MODE) {
          set({ initialized: true, membership: DEMO_OWNER, error: null });
          return;
        }

        set({ loading: true, error: null });
        const claim = await supabase.rpc("claim_workspace_membership");
        if (claim.error) {
          set({ loading: false, initialized: true, error: claim.error.message });
          return;
        }

        const payload = claim.data as { memberships?: RpcMembership[] } | null;
        const membership = payload?.memberships?.[0]
          ? mapMembership(payload.memberships[0])
          : null;
        set({
          loading: false,
          initialized: true,
          membership,
          error: membership ? null : "這個帳號尚未被加入任何旅宿。",
        });
      },

      refreshMembers: async () => {
        const membership = get().membership;
        if (!membership) return;
        if (DEMO_MODE) return;

        set({ loading: true, error: null });
        const response = await supabase.rpc("list_workspace_members", {
          p_tenant_id: membership.tenantId,
        });
        if (response.error) {
          set({ loading: false, error: response.error.message });
          return;
        }
        set({
          loading: false,
          members: ((response.data as RpcMember[] | null) ?? []).map(mapMember),
        });
      },

      saveMember: async (input) => {
        const membership = get().membership;
        if (!membership) throw new Error("尚未取得旅宿權限");
        if (!ROLE_DEFINITIONS[membership.role].permissions.manageMembers) {
          throw new Error("只有擁有者可以調整成員權限");
        }

        if (DEMO_MODE) {
          const now = new Date().toISOString();
          set((state) => {
            const current = input.id
              ? state.members.find((member) => member.id === input.id)
              : undefined;
            const next: WorkspaceMember = {
              id: current?.id ?? demoId(),
              displayName: input.displayName.trim(),
              email: input.email.trim().toLowerCase() || null,
              phone: input.phone.trim() || null,
              role: input.role,
              status: current?.status ?? "invited",
              allProperties: input.allProperties,
              propertyIds: input.allProperties
                ? ["sweetfun", "offland"]
                : input.propertyIds,
              invitedAt: current?.invitedAt ?? now,
              acceptedAt: current?.acceptedAt ?? null,
              lastActiveAt: current?.lastActiveAt ?? null,
            };
            return {
              members: current
                ? state.members.map((member) => (member.id === next.id ? next : member))
                : [...state.members, next],
            };
          });
          return;
        }

        const response = await supabase.rpc("save_workspace_member", {
          p_tenant_id: membership.tenantId,
          p_display_name: input.displayName.trim(),
          p_role: input.role,
          p_all_properties: input.allProperties,
          p_property_ids: input.propertyIds,
          p_member_id: input.id ?? null,
          p_email: input.email.trim().toLowerCase() || null,
          p_phone_e164: input.phone.trim() || null,
        });
        if (response.error) throw response.error;
        await get().refreshMembers();
      },

      setMemberStatus: async (memberId, status) => {
        const membership = get().membership;
        if (!membership) throw new Error("尚未取得旅宿權限");
        if (!ROLE_DEFINITIONS[membership.role].permissions.manageMembers) {
          throw new Error("只有擁有者可以調整成員權限");
        }

        if (DEMO_MODE) {
          set((state) => ({
            members: state.members.map((member) =>
              member.id === memberId ? { ...member, status } : member,
            ),
          }));
          return;
        }

        const response = await supabase.rpc("set_workspace_member_status", {
          p_member_id: memberId,
          p_status: status,
        });
        if (response.error) throw response.error;
        await get().refreshMembers();
      },

      setPreviewRole: (previewRole) => set({ previewRole }),

      reset: () =>
        set({
          initialized: DEMO_MODE,
          loading: false,
          error: null,
          membership: DEMO_MODE ? DEMO_OWNER : null,
          previewRole: null,
          members: DEMO_MODE ? DEFAULT_DEMO_MEMBERS : [],
        }),
    }),
    {
      name: "sweetfun-os-access-control",
      partialize: (state) => ({
        previewRole: state.previewRole,
        members: DEMO_MODE ? state.members : [],
      }),
    },
  ),
);

export function useActorPermissions() {
  return useAccessControl((state) =>
    ROLE_DEFINITIONS[state.membership?.role ?? "viewer"].permissions,
  );
}

export function useEffectiveRole() {
  return useAccessControl(
    (state) => state.previewRole ?? state.membership?.role ?? "viewer",
  );
}

export function useEffectivePermissions() {
  return useAccessControl((state) => {
    const role = state.previewRole ?? state.membership?.role ?? "viewer";
    return ROLE_DEFINITIONS[role].permissions;
  });
}

export async function claimWorkspaceMembership() {
  if (DEMO_MODE) return { memberships: [DEMO_OWNER] };
  const { data, error } = await supabase.rpc("claim_workspace_membership");
  if (error) throw error;
  return data;
}
