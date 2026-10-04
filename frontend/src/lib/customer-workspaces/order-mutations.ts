import { randomUUID } from "node:crypto";
import { mutationContext, saveMutation } from "./mutations.ts";
import { dateValue, textValue, view } from "./service.ts";
import { tagsFor } from "./order-query.ts";
import type { CustomerStore } from "./store.ts";
import type { OrderTag } from "./types.ts";

export async function orderMutation(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const action = String(input.action);
  if (
    !["order-details", "order-tags", "tag", "receipt-account"].includes(action)
  )
    throw new Error("INVALID_INPUT");
  const { requestKey: _key, version: _version, ...normalized } = input;
  void _key;
  void _version;
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    action,
    normalized,
    action === "tag" || action === "receipt-account"
      ? ["owner", "admin"]
      : ["owner", "admin", "housekeeper"],
  );
  const booking = context.workspace.bookings.find(
    (b) => b.id === input.bookingId,
  );
  if (action.startsWith("order-") && !booking) throw new Error("NOT_FOUND");
  const propertyId = action.startsWith("order-")
    ? booking!.propertyId
    : input.propertyId;
  const property = context.workspace.properties.find(
    (p) =>
      p.id === propertyId &&
      (context.member.allProperties ||
        context.member.propertyIds.includes(p.id)),
  );
  if (!property) throw new Error("NOT_FOUND");
  if (context.previous) {
    if (booking?.version === Number(input.bookingVersion) + 1) {
      if (
        action === "order-details" &&
        ((input.notes !== undefined &&
          booking.notes !== textValue(input.notes, 2000)) ||
          (input.platform !== undefined &&
            booking.platform !== textValue(input.platform, 80)) ||
          (input.bookedAt !== undefined &&
            (booking.bookedAt ?? null) !==
              (input.bookedAt ? dateValue(input.bookedAt) : null)))
      )
        throw new Error("WRITE_UNCONFIRMED");
      if (
        action === "order-tags" &&
        JSON.stringify(booking.tagIds) !==
          JSON.stringify([...new Set(input.tagIds as string[])])
      )
        throw new Error("WRITE_UNCONFIRMED");
    }
    return {
      workspace: view(context.workspace, context.member),
      targetId: context.previous.targetId,
    };
  }
  let next = { ...context.workspace };
  let targetId: string;
  if (action.startsWith("order-")) {
    if (booking!.version !== input.bookingVersion)
      throw new Error("VERSION_CONFLICT");
    const updated = { ...booking!, version: booking!.version + 1 };
    if (action === "order-details") {
      if (input.notes !== undefined)
        updated.notes = textValue(input.notes, 2000);
      if (input.platform !== undefined)
        updated.platform = textValue(input.platform, 80);
      const bookedAt = input.bookedAt ? dateValue(input.bookedAt) : null;
      if (
        input.bookedAt !== undefined &&
        bookedAt !== (booking!.bookedAt ?? null)
      ) {
        updated.bookedAt = bookedAt;
        updated.bookedAtSource = "manual";
        updated.bookedAtTimeZone = "Asia/Taipei";
      }
    } else {
      const tags = tagsFor(property);
      if (
        !Array.isArray(input.tagIds) ||
        input.tagIds.length > 30 ||
        input.tagIds.some(
          (id) => typeof id !== "string" || !tags.some((t) => t.id === id),
        )
      )
        throw new Error("INVALID_INPUT");
      updated.tagIds = [...new Set(input.tagIds as string[])];
    }
    targetId = updated.id;
    next.bookings = next.bookings.map((b) =>
      b.id === updated.id ? updated : b,
    );
  } else {
    const updated = { ...property };
    if (action === "tag") {
      const tags = tagsFor(property);
      const id = input.tagId
        ? textValue(input.tagId, 100, true)!
        : randomUUID();
      if (input.tagId && !tags.some((t) => t.id === id))
        throw new Error("NOT_FOUND");
      const name = textValue(input.name, 30, true)!,
        short = textValue(input.short, 10, true)!;
      const color = input.color as OrderTag["color"];
      if (
        [
          ...new Intl.Segmenter("zh-TW", { granularity: "grapheme" }).segment(
            short,
          ),
        ].length !== 1 ||
        !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(short) ||
        !["blue", "orange", "purple", "green", "rose", "slate"].includes(color)
      )
        throw new Error("INVALID_INPUT");
      if (
        tags.some(
          (t) =>
            t.id !== id &&
            (t.short.normalize("NFKC").toLowerCase() ===
              short.normalize("NFKC").toLowerCase() ||
              t.name === name),
        )
      )
        throw new Error("TAG_EXISTS");
      if (!input.tagId && tags.length >= 30) throw new Error("LIMIT_REACHED");
      updated.tags = [
        ...tags.filter((t) => t.id !== id),
        { id, name, short, color },
      ];
      targetId = id;
    } else {
      const accounts = property.receiptAccounts ?? [];
      const name = textValue(input.name, 60, true)!,
        last4 = textValue(input.last4, 4, true)!;
      if (!/^\d{4}$/.test(last4)) throw new Error("INVALID_INPUT");
      if (accounts.some((a) => a.name === name && a.last4 === last4))
        throw new Error("ACCOUNT_DUPLICATE");
      if (accounts.length >= 30) throw new Error("LIMIT_REACHED");
      targetId = randomUUID();
      updated.receiptAccounts = [...accounts, { id: targetId, name, last4 }];
    }
    next = {
      ...next,
      properties: next.properties.map((p) =>
        p.id === property.id ? updated : p,
      ),
    };
  }
  const saved = await saveMutation(store, context, next, targetId);
  // Check the stored target, not only the operation receipt. A later version
  // may legitimately include another accepted edit after our atomic commit.
  if (saved.workspace.version === context.workspace.version + 1) {
    const actual = action.startsWith("order-")
      ? saved.workspace.bookings.find((b) => b.id === targetId)
      : saved.workspace.properties.find((p) => p.id === property.id);
    const expected = action.startsWith("order-")
      ? next.bookings.find((b) => b.id === targetId)
      : next.properties.find((p) => p.id === property.id);
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error("WRITE_UNCONFIRMED");
  }
  return { workspace: view(saved.workspace, saved.member), targetId };
}
