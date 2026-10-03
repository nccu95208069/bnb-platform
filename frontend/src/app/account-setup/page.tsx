import { AccountSetup } from "@/components/customer-workspaces/account-setup";
export const metadata = {
  title: "確認信箱與設定密碼｜旅宿服務",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default function Page() {
  return <AccountSetup />;
}
