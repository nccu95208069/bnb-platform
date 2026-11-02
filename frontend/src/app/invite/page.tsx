import { InvitationSetup } from "@/components/customer-workspaces/invitation";
export const metadata = {
  title: "加入旅宿協作",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default function Page() {
  return <InvitationSetup />;
}
