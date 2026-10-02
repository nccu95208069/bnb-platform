import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import {
  createPasswordCredential,
  credentialMatches,
} from "../owner-password.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { loadWorkspace } from "./service.ts";
import { mutationContext, saveMutation, withReceipt } from "./mutations.ts";
import { customerOrigin } from "./site-url.ts";
import type { CustomerStore } from "./store.ts";
import type {
  Account,
  Invitation,
  Membership,
  Role,
  Workspace,
} from "./types.ts";

const assignable = ["admin", "housekeeper", "viewer", "viewer_no_price"];
export const roleLabels: Record<Role, string> = {
  owner: "業主",
  admin: "管理員",
  housekeeper: "管家",
  viewer: "僅查看（含價格）",
  viewer_no_price: "僅查看（不含價格，適合清潔協作）",
};
function scope(workspace: Workspace, input: Record<string, unknown>) {
  if (
    !assignable.includes(String(input.role)) ||
    typeof input.allProperties !== "boolean" ||
    !Array.isArray(input.propertyIds)
  )
    throw new Error("INVALID_INPUT");
  if (
    input.propertyIds.some(
      (id) =>
        typeof id !== "string" ||
        !workspace.properties.some((p) => p.id === id),
    )
  )
    throw new Error("INVALID_INPUT");
  const propertyIds = [...new Set(input.propertyIds as string[])].sort();
  if (!input.allProperties && !propertyIds.length)
    throw new Error("INVALID_INPUT");
  return {
    role: input.role as Exclude<Role, "owner">,
    allProperties: input.allProperties,
    propertyIds: input.allProperties ? [] : propertyIds,
  };
}
function signature(workspaceId: string, invitation: Invitation) {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("FEATURE_UNAVAILABLE");
  return createHmac("sha256", secret)
    .update(
      `customer-invitation:v1:${workspaceId}:${invitation.id}:${invitation.generation}:${invitation.email}`,
    )
    .digest("base64url");
}
export function invitationUrl(workspaceId: string, invitation: Invitation) {
  return `${customerOrigin()}/invite#${invitation.id}.${signature(workspaceId, invitation)}`;
}
export async function createInvitation(
  store: CustomerStore,
  account: Account,
  slug: string,
  input: Record<string, unknown>,
) {
  const email = normalizedEmail(input.email);
  if (!validEmail(email) || email === account.email)
    throw new Error("INVALID_INPUT");
  const loaded = await loadWorkspace(store, account.id, slug);
  const permissions = scope(loaded.workspace, input);
  const context = await mutationContext(
    store,
    account.id,
    slug,
    input,
    "member.invited",
    { email, ...permissions },
    ["owner"],
  );
  if (context.previous) {
    const invitation = context.workspace.invitations?.find(
      (i) => i.id === context.previous!.targetId,
    );
    if (
      !invitation ||
      invitation.revokedAt ||
      invitation.expiresAt <= Date.now()
    )
      throw new Error("INVITATION_INVALID");
    return { workspace: context.workspace, invitation };
  }
  const existingAccount = (await store.read<Account>(accountKey(email))).value;
  if (
    context.workspace.members.some(
      (m) => m.email === email || m.accountId === existingAccount?.id,
    )
  )
    throw new Error("MEMBER_EXISTS");
  if (
    context.workspace.invitations?.some(
      (i) =>
        i.email === email &&
        !i.revokedAt &&
        !i.acceptedAt &&
        i.expiresAt > Date.now(),
    )
  )
    throw new Error("INVITATION_EXISTS");
  if (
    (context.workspace.invitations?.length ?? 0) >= 500 ||
    context.workspace.members.length >= 100
  )
    throw new Error("LIMIT_REACHED");
  const invitation: Invitation = {
    id: randomUUID(),
    email,
    ...permissions,
    generation: randomUUID(),
    expiresAt: Date.now() + 7 * 86400000,
    createdAt: new Date().toISOString(),
  };
  const next = withReceipt(
    {
      ...context.workspace,
      invitations: [...(context.workspace.invitations ?? []), invitation],
    },
    context,
    invitation.id,
  );
  await store.commit([
    { key: `workspace:${next.id}`, before: context.raw, after: next },
    {
      key: `invitation:${invitation.id}`,
      before: null,
      after: { workspaceId: next.id, slug },
      ttlSeconds: 8 * 86400,
    },
  ]);
  const verified = (await loadWorkspace(store, account.id, slug)).workspace;
  const saved = verified.invitations?.find((i) => i.id === invitation.id);
  const locator = (
    await store.read<{ workspaceId: string }>(`invitation:${invitation.id}`)
  ).value;
  if (!saved || saved.email !== email || locator?.workspaceId !== next.id)
    throw new Error("WRITE_UNCONFIRMED");
  return { workspace: verified, invitation: saved };
}

async function checkInvitation(store: CustomerStore, token: unknown) {
  if (typeof token !== "string" || token.length > 100)
    throw new Error("INVITATION_INVALID");
  const [id, mac, ...extra] = token.split(".");
  if (!/^[-\w]{36}$/.test(id) || !/^[\w-]{43}$/.test(mac ?? "") || extra.length)
    throw new Error("INVITATION_INVALID");
  const locator = (
    await store.read<{ workspaceId: string; slug: string }>(`invitation:${id}`)
  ).value;
  if (!locator) throw new Error("INVITATION_INVALID");
  const snapshot = await store.read<Workspace>(
      `workspace:${locator.workspaceId}`,
    ),
    workspace = snapshot.value;
  const invitation = workspace?.invitations?.find((i) => i.id === id);
  if (
    !workspace ||
    workspace.slug !== locator.slug ||
    !invitation ||
    invitation.revokedAt ||
    invitation.expiresAt <= Date.now() ||
    !timingSafeEqual(
      Buffer.from(signature(workspace.id, invitation)),
      Buffer.from(mac),
    )
  )
    throw new Error("INVITATION_INVALID");
  return { workspace, raw: snapshot.raw, invitation };
}
export async function invitationInfo(store: CustomerStore, token: unknown) {
  const { workspace, invitation } = await checkInvitation(store, token);
  return {
    email: invitation.email,
    workspace: workspace.name,
    role: roleLabels[invitation.role],
    properties: invitation.allProperties
      ? ["全部旅宿（含日後新增）"]
      : workspace.properties
          .filter((p) => invitation.propertyIds.includes(p.id))
          .map((p) => p.name),
    existingAccount: Boolean(
      (await store.read<Account>(accountKey(invitation.email))).value,
    ),
    accepted: Boolean(invitation.acceptedAt),
  };
}
export async function acceptInvitation(
  store: CustomerStore,
  token: unknown,
  password: unknown,
  confirmation: unknown,
) {
  const { workspace, raw, invitation } = await checkInvitation(store, token);
  await store.limit(`invitation-accept:${digest(invitation.email)}`, 15);
  const key = accountKey(invitation.email),
    current = await store.read<Account>(key);
  if (typeof password !== "string") throw new Error("PASSWORD_INVALID");
  if (
    current.value &&
    !(await credentialMatches(password, current.value.credential))
  )
    throw new Error("UNAUTHORIZED");
  if (!current.value && password !== confirmation)
    throw new Error("PASSWORD_INVALID");
  if (invitation.acceptedAt) {
    if (
      !current.value ||
      invitation.accountId !== current.value.id ||
      !workspace.members.some(
        (m) => m.accountId === current.value!.id && m.active,
      )
    )
      throw new Error("INVITATION_INVALID");
    return { account: current.value, slug: workspace.slug };
  }
  if (
    current.value &&
    workspace.members.some((m) => m.accountId === current.value!.id)
  )
    throw new Error("MEMBER_EXISTS");
  if (
    (current.value?.workspaces.length ?? 0) >= 50 ||
    workspace.members.length >= 100
  )
    throw new Error("LIMIT_REACHED");
  scope(workspace, invitation);
  const at = new Date().toISOString();
  const account: Account = current.value ?? {
    id: randomUUID(),
    email: invitation.email,
    credential: await createPasswordCredential(password),
    emailVerifiedAt: at,
    workspaces: [],
  };
  const reference = {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    creationKey: `invitation-${invitation.id}`,
    creationHash: digest(invitation.id),
  };
  const nextAccount = {
    ...account,
    emailVerifiedAt: account.emailVerifiedAt ?? at,
    workspaces: [...account.workspaces, reference],
  };
  const member: Membership = {
    accountId: account.id,
    email: account.email,
    role: invitation.role,
    active: true,
    allProperties: invitation.allProperties,
    propertyIds: invitation.propertyIds,
  };
  const nextWorkspace: Workspace = {
    ...workspace,
    version: workspace.version + 1,
    members: [...workspace.members, member],
    invitations: workspace.invitations!.map((i) =>
      i.id === invitation.id
        ? { ...i, acceptedAt: at, accountId: account.id }
        : i,
    ),
    audit: [
      ...workspace.audit,
      {
        at,
        actor: account.id,
        action: "member.accepted",
        targetId: invitation.id,
      },
    ],
  };
  await store.commit([
    { key, before: current.raw, after: nextAccount },
    { key: `workspace:${workspace.id}`, before: raw, after: nextWorkspace },
  ]);
  const verified = (await store.read<Account>(key)).value;
  const checked = await loadWorkspace(store, account.id, workspace.slug);
  if (
    !verified ||
    !verified.workspaces.some((w) => w.id === workspace.id) ||
    checked.member.role !== member.role ||
    checked.member.email !== account.email
  )
    throw new Error("WRITE_UNCONFIRMED");
  return { account: verified, slug: workspace.slug };
}

export async function manageMember(
  store: CustomerStore,
  accountId: string,
  slug: string,
  input: Record<string, unknown>,
) {
  const action = input.action;
  if (action !== "member" && action !== "revoke")
    throw new Error("INVALID_INPUT");
  const loaded = await loadWorkspace(store, accountId, slug);
  const data =
    action === "member"
      ? {
          accountId: input.accountId,
          active: input.active,
          ...scope(loaded.workspace, input),
        }
      : { invitationId: input.invitationId };
  if (action === "member" && typeof input.active !== "boolean")
    throw new Error("INVALID_INPUT");
  const context = await mutationContext(
    store,
    accountId,
    slug,
    input,
    action === "member" ? "member.updated" : "invitation.revoked",
    data,
    ["owner"],
  );
  if (context.previous) return memberSettings(store, accountId, slug);
  let next = context.workspace,
    targetId: string;
  if (action === "revoke") {
    const invitation = next.invitations?.find(
      (i) => i.id === input.invitationId,
    );
    if (!invitation || invitation.acceptedAt)
      throw new Error("INVITATION_INVALID");
    targetId = invitation.id;
    next = {
      ...next,
      invitations: next.invitations!.map((i) =>
        i.id === invitation.id
          ? { ...i, revokedAt: new Date().toISOString() }
          : i,
      ),
    };
  } else {
    const member = next.members.find((m) => m.accountId === input.accountId);
    if (!member) throw new Error("NOT_FOUND");
    if (member.role === "owner" || member.accountId === accountId)
      throw new Error("FORBIDDEN");
    targetId = member.accountId;
    next = {
      ...next,
      members: next.members.map((m) =>
        m.accountId === member.accountId
          ? { ...m, ...scope(next, input), active: input.active as boolean }
          : m,
      ),
    };
  }
  await saveMutation(store, context, next, targetId);
  return memberSettings(store, accountId, slug);
}
export async function memberSettings(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  if (member.role !== "owner") throw new Error("FORBIDDEN");
  return {
    version: workspace.version,
    members: workspace.members.map((m) => ({
      ...m,
      email:
        m.email ??
        (m.accountId === accountId ? "目前登入的業主" : "未保存信箱"),
    })),
    invitations: (workspace.invitations ?? []).map(
      ({ generation: _generation, ...i }) => {
        void _generation;
        return i;
      },
    ),
  };
}
