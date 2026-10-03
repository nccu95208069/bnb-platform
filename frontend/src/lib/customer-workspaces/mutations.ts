import { digest } from "./auth.ts";
import { loadWorkspace, requestKey } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Role, Workspace } from "./types.ts";

export async function mutationContext(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
  action: string,
  normalized: unknown,
  roles: Role[],
) {
  const loaded = await loadWorkspace(store, accountId, slug);
  if (!roles.includes(loaded.member.role)) throw new Error("FORBIDDEN");
  const key = requestKey(input.requestKey);
  const hash = digest(JSON.stringify({ action, normalized }));
  const previous = loaded.workspace.operations?.find(
    (o) => o.key === key && o.actor === accountId,
  );
  if (previous && (previous.hash !== hash || previous.action !== action))
    throw new Error("IDEMPOTENCY_CONFLICT");
  if (!previous && loaded.workspace.version !== input.version)
    throw new Error("VERSION_CONFLICT");
  if (!previous && (loaded.workspace.operations?.length ?? 0) >= 20000)
    throw new Error("LIMIT_REACHED");
  return { ...loaded, key, hash, previous, action, accountId };
}

export function withReceipt(
  workspace: Workspace,
  context: Awaited<ReturnType<typeof mutationContext>>,
  targetId: string,
): Workspace {
  return {
    ...workspace,
    version: workspace.version + 1,
    operations: [
      ...(workspace.operations ?? []),
      {
        key: context.key,
        actor: context.accountId,
        hash: context.hash,
        action: context.action,
        targetId,
      },
    ],
    audit: [
      ...workspace.audit,
      {
        at: new Date().toISOString(),
        actor: context.accountId,
        action: context.action,
        targetId,
      },
    ],
  };
}

export async function saveMutation(
  store: CustomerStore,
  context: Awaited<ReturnType<typeof mutationContext>>,
  next: Workspace,
  targetId: string,
) {
  await store.commit([
    {
      key: `workspace:${next.id}`,
      before: context.raw,
      after: withReceipt(next, context, targetId),
    },
  ]);
  const verified = await loadWorkspace(store, context.accountId, next.slug);
  if (
    !verified.workspace.operations?.some(
      (o) =>
        o.key === context.key &&
        o.actor === context.accountId &&
        o.hash === context.hash &&
        o.targetId === targetId,
    )
  )
    throw new Error("WRITE_UNCONFIRMED");
  return verified;
}
