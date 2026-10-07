import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { principalFor } from "@/lib/workspace-auth/session";
export const dynamic = "force-dynamic";
export const metadata = { title: "訂單健檢｜Sweetfun OS", robots: { index: false, follow: false } };
export default async function OrderHealthEntry() {
  const principal = await principalFor({ cookies: await cookies() });
  redirect(principal ? "/revenue" : "/calendar-access?next=/revenue");
}
