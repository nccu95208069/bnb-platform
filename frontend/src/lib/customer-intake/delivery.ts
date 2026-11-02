import type { CustomerStore } from "../customer-workspaces/store.ts";
export type Delivery = {
  status: "sending" | "accepted" | "needs_attention" | "preview";
  attemptedAt: string;
  messageId?: string;
};
export type CustomerMail = (
  to: string,
  subject: string,
  text: string,
) => Promise<string>;
export async function deliverOnce(
  store: CustomerStore,
  key: string,
  to: string,
  subject: string,
  text: string,
  send: CustomerMail,
  preview = false,
): Promise<Delivery> {
  const previous = await store.read<Delivery>(key);
  if (previous.value) return previous.value;
  const claimed: Delivery = {
    status: preview ? "preview" : "sending",
    attemptedAt: new Date().toISOString(),
  };
  await store.commit([
    { key, before: previous.raw, after: claimed, ttlSeconds: 90 * 86400 },
  ]);
  if (preview) return claimed;
  let final: Delivery;
  try {
    const messageId = await send(to, subject, text);
    if (!messageId) throw Error();
    final = { ...claimed, status: "accepted", messageId };
  } catch {
    final = { ...claimed, status: "needs_attention" };
  }
  const before = await store.read<Delivery>(key);
  if (
    before.value?.status !== "sending" ||
    before.value.attemptedAt !== claimed.attemptedAt
  )
    throw new Error("WRITE_UNCONFIRMED");
  await store.commit([
    { key, before: before.raw, after: final, ttlSeconds: 90 * 86400 },
  ]);
  const result = (await store.read<Delivery>(key)).value;
  if (result?.status !== final.status) throw new Error("WRITE_UNCONFIRMED");
  return result;
}
