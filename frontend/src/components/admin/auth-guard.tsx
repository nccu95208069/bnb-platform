"use client";

import { useEffect } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { useAccess } from "@/components/access/access-provider";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/supabase/auth";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, user, error, refresh } = useAccess();

  useEffect(() => {
    if (status === "signed_out") router.replace("/admin/login");
  }, [router, status]);

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (status === "signed_out") return null;

  if (status === "unauthorized" || status === "error") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-muted/20 p-5">
        <div className="w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-amber-50 text-amber-700">
            <ShieldAlert className="size-6" />
          </span>
          <h1 className="mt-4 text-xl font-semibold">
            {status === "unauthorized" ? "這個帳號尚未被授權" : "無法讀取帳號權限"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {status === "unauthorized"
              ? `${user?.email ?? user?.phone ?? "目前帳號"} 尚未加入任何旅宿工作區，請由管理者以相同 Email 或手機號碼建立權限。`
              : error ?? "請稍後再試。"}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={() => void refresh()}>
              重新檢查
            </Button>
            <Button
              onClick={async () => {
                await signOut();
                router.replace("/admin/login");
              }}
            >
              使用其他帳號
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
