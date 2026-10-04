"use client";
import { useCallback, type ComponentProps } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ServiceJoin } from "./service-join";
// A shared route layout keeps questionnaire/contact state alive through browser Back/Forward.
export function ServiceIntakeRouter(
  props: Pick<
    ComponentProps<typeof ServiceJoin>,
    | "enabled"
    | "preview"
    | "shareEmail"
    | "contactEmail"
    | "initialTheme"
    | "workflowEnabled"
  >,
) {
  const router = useRouter();
  const pathname = usePathname();
  const open = useCallback(() => router.push("/join/contact"), [router]);
  const restore = useCallback(() => router.replace("/join/contact"), [router]);
  const back = useCallback(
    (toQuestionnaire: boolean) =>
      router.push(toQuestionnaire ? "/join#join-questions" : "/join"),
    [router],
  );
  return (
    <div hidden={pathname !== "/join" && pathname !== "/join/contact"}>
      <ServiceJoin
        {...props}
        contactPage={pathname === "/join/contact"}
        onOpenContact={open}
        onRestoreContact={restore}
        onBack={back}
      />
    </div>
  );
}
