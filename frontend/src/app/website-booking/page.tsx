import { OwnerConnection } from "@/components/website-booking/owner-connection";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "連接官網訂房日曆｜Sweetfun OS",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string | string[] }>;
}) {
  const search = await searchParams;
  return (
    <OwnerConnection
      key={typeof search.connection === "string" ? search.connection : "invalid"}
      connectionId={typeof search.connection === "string" ? search.connection : ""}
    />
  );
}
