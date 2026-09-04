import { AuthGuard } from "@/components/admin/auth-guard";
import { Sidebar } from "@/components/sidebar";

export default function MainLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden bg-muted/20">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1680px] p-4 md:p-6">{children}</div>
        </main>
      </div>
    </AuthGuard>
  );
}
