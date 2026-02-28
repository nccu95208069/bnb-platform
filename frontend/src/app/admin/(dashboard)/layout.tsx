"use client";

import { AuthGuard } from "@/components/admin/auth-guard";

export default function AdminDashboardLayout({
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
