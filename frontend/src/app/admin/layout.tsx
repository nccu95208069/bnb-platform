"use client";

import { AuthGuard } from "@/components/admin/auth-guard";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="container max-w-6xl p-6">{children}</div>
    </AuthGuard>
  );
}
