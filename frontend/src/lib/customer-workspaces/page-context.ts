import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, CUSTOMER_COOKIE, enabled } from "./auth";
import { RedisCustomerStore } from "./store";
import { loadWorkspace, view } from "./service";
export async function customerPage(slug: string, route: string) {
  if (!enabled()) return null;
  const store = new RedisCustomerStore();
  let account;
  try {
    account = await authenticate(
      store,
      (await cookies()).get(CUSTOMER_COOKIE)?.value,
    );
  } catch (e) {
    if (e instanceof Error && e.message === "UNAUTHORIZED")
      redirect(`/start?next=${encodeURIComponent(`/w/${slug}/${route}`)}`);
    throw e;
  }
  try {
    const { workspace, member } = await loadWorkspace(store, account.id, slug);
    return view(workspace, member);
  } catch (e) {
    if (e instanceof Error && e.message === "NOT_FOUND") return null;
    throw e;
  }
}
