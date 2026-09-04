import { AuthGuard } from "@/components/admin/auth-guard";
import { Sidebar } from "@/components/sidebar";

export default function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
