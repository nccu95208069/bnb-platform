"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Session, User } from "@supabase/supabase-js";

import {
  DEMO_MEMBERSHIP,
  type WorkspaceMembership,
  type WorkspacePermissions,
} from "@/lib/access-control";
import { supabase } from "@/lib/supabase/client";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

type AccessStatus = "loading" | "ready" | "signed_out" | "unauthorized" | "error";

type AccessContextValue = {
  status: AccessStatus;
  user: User | null;
  session: Session | null;
  membership: WorkspaceMembership | null;
  memberships: WorkspaceMembership[];
  permissions: WorkspacePermissions;
  error: string | null;
  refresh: () => Promise<void>;
  canAccessProperty: (propertyId: string) => boolean;
};

const EMPTY_PERMISSIONS: WorkspacePermissions = {
  manage_members: false,
  edit_bookings: false,
  record_payments: false,
  cancel_bookings: false,
  view_prices: false,
};

const AccessContext = createContext<AccessContextValue | null>(null);

function parseMemberships(value: unknown): WorkspaceMembership[] {
  if (!value || typeof value !== "object") return [];
  const memberships = (value as { memberships?: unknown }).memberships;
  if (!Array.isArray(memberships)) return [];
  return memberships.filter(
    (membership): membership is WorkspaceMembership =>
      Boolean(
        membership &&
          typeof membership === "object" &&
          typeof (membership as WorkspaceMembership).id === "string" &&
          typeof (membership as WorkspaceMembership).tenant_id === "string" &&
          (membership as WorkspaceMembership).status === "active",
      ),
  );
}

export function AccessProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AccessStatus>(DEMO_MODE ? "ready" : "loading");
  const [session, setSession] = useState<Session | null>(null);
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>(
    DEMO_MODE ? [DEMO_MEMBERSHIP] : [],
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (DEMO_MODE) {
      setMemberships([DEMO_MEMBERSHIP]);
      setStatus("ready");
      setError(null);
      return;
    }

    setStatus("loading");
    setError(null);
    const {
      data: { session: currentSession },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) {
      setSession(null);
      setMemberships([]);
      setStatus("error");
      setError(sessionError.message);
      return;
    }

    setSession(currentSession);
    if (!currentSession) {
      setMemberships([]);
      setStatus("signed_out");
      return;
    }

    const { data, error: claimError } = await supabase.rpc("claim_workspace_membership");
    if (claimError) {
      setMemberships([]);
      setStatus("error");
      setError(claimError.message);
      return;
    }

    const claimedMemberships = parseMemberships(data);
    setMemberships(claimedMemberships);
    setStatus(claimedMemberships.length > 0 ? "ready" : "unauthorized");
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;
    void refresh();
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      void refresh();
    });
    return () => subscription.unsubscribe();
  }, [refresh]);

  const membership = memberships[0] ?? null;
  const permissions = membership?.permissions ?? EMPTY_PERMISSIONS;
  const value = useMemo<AccessContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      session,
      membership,
      memberships,
      permissions,
      error,
      refresh,
      canAccessProperty: (propertyId: string) =>
        Boolean(
          membership &&
            (membership.all_properties || membership.property_ids.includes(propertyId)),
        ),
    }),
    [error, membership, memberships, permissions, refresh, session, status],
  );

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export function useAccess() {
  const context = useContext(AccessContext);
  if (!context) throw new Error("useAccess must be used inside AccessProvider");
  return context;
}
