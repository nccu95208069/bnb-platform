import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { CalendarSessionData } from "@/lib/workspace-auth/session";
import { calendarBootstrapFor } from "@/lib/calendar-session-bootstrap";
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
  let initialSession: CalendarSessionData | undefined;
  let initialAuthMs: number | undefined;
  if (process.env.NEXT_PUBLIC_CALENDAR_SOURCE === "sheet_snapshot") {
    const request = { cookies: await cookies() };
    const bootstrap = await calendarBootstrapFor(request);
    initialSession = bootstrap.session;
    initialAuthMs = bootstrap.authMs;
    if (initialSession.requires_password_reset) redirect("/reset-password");
    if (!initialSession.authenticated) redirect("/calendar-access");
  }
  if (fixedPreview) return <AuthGuard initialSession={initialSession} initialAuthMs={initialAuthMs}><SnapshotPreviewShell>{children}</SnapshotPreviewShell></AuthGuard>;
  return (
    <AuthGuard initialSession={initialSession} initialAuthMs={initialAuthMs}>
      <div className="flex min-h-dvh bg-muted/20 md:h-screen md:overflow-hidden">
        <Sidebar />
        <main className="min-w-0 flex-1 pt-14 md:overflow-y-auto md:pt-0">
          <div className="mx-auto w-full max-w-[1760px] p-2 sm:p-4 md:p-6">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
