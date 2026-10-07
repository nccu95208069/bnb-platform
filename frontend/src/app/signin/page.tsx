import { EmailSignIn } from "@/components/customer-workspaces/email-signin";
export const metadata = {
  title: "免密碼登入｜旅宿工作區",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default function Page() {
  return <EmailSignIn />;
}
