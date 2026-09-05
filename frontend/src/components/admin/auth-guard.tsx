"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAccessControl } from "@/lib/access-control";
import { signOut } from "@/lib/supabase/auth";
import { supabase } from "@/lib/supabase/client";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

function LoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function SupabaseAuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isChecking, setIsChecking] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const initialized = useAccessControl((state) => state.initialized);
  const loading = useAccessControl((state) => state.loading);
  const membership = useAccessControl((state) => state.membership);
  const error = useAccessControl((state) => state.error);
  const initialize = useAccessControl((state) => state.initialize);
  const resetAccess = useAccessControl((state) => state.reset);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!active) return;
      if (session) {
        setIsAuthenticated(true);
        await initialize();
      } else {
        router.replace("/admin/login");
      }
      if (active) setIsChecking(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setIsAuthenticated(false);
        resetAccess();
        router.replace("/admin/login");
      } else {
        setIsAuthenticated(true);
        void initialize();
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [initialize, resetAccess, router]);

  if (isChecking || loading || (isAuthenticated && !initialized)) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) return null;

  if (!membership) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-muted/25 p-4">
        <div className="w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <ShieldAlert className="size-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">帳號尚未取得權限</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {error ?? "請旅宿擁有者先用這組 Email 或手機加入你，再重新登入。"}
          </p>
          <Button
            className="mt-5"
            variant="outline"
            onClick={async () => {
              await signOut();
              resetAccess();
              router.replace("/admin/login");
            }}
          >
            返回登入
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  if (DEMO_MODE) {
    return <>{children}</>;
  }

  return <SupabaseAuthGuard>{children}</SupabaseAuthGuard>;
}
