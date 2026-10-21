import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { principalFor, sessionMember } from "@/lib/workspace-auth/session";
import { AuthGuard } from "@/components/admin/auth-guard";
import { Sidebar } from "@/components/sidebar";
import { SnapshotPreviewShell } from "@/components/calendar/snapshot-preview-shell";

export default async function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const fixedPreview = process.env.VERCEL_ENV === "preview" &&
    process.env.IRON_GATE_PREVIEW_OWNER_ONLY === "true";
  if (process.env.NEXT_PUBLIC_CALENDAR_SOURCE === "sheet_snapshot") {
    const request = { cookies: await cookies() };
    if ((await sessionMember(request))?.mustResetPassword) redirect("/reset-password");
    if (!await principalFor(request)) redirect("/calendar-access");
  }
  if (fixedPreview) return <AuthGuard><SnapshotPreviewShell>{children}</SnapshotPreviewShell></AuthGuard>;
  return (
    <AuthGuard>
      <div className="flex min-h-dvh bg-muted/20 md:h-screen md:overflow-hidden">
        <Sidebar />
        <main className="min-w-0 flex-1 pt-14 md:overflow-y-auto md:pt-0">
          <div className="mx-auto w-full max-w-[1760px] p-2 sm:p-4 md:p-6">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
