import { randomUUID } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import { bookingsOverlap, propertyReadiness } from "../customer-workspaces/domain.ts";
import { occupiesInventory } from "../customer-workspaces/hold-state.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { Workspace } from "../customer-workspaces/types.ts";
import { authorizedGrant, grantOwnerActive } from "./grants.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9._:-]{1,128}$/;
type StockCell = { roomId: string; date: string; count: number; isLock: boolean };
type ProviderReadback = { observedAt: string; sourceVersion: string; cells: StockCell[] };
type CellEvidence = { observedAt: string; sourceVersion: string; cell: StockCell;
  nightOperationKey: string; recordedWorkspaceVersion: number };
type Fence = NonNullable<Workspace["integrationFences"]>[number];
type Receipt = { grantId: string; propertyId: string; operationKey: string; inputHash: string; fenceId: string;
  mode: "open" | "close"; closedFenceId: string | null; status: "pending" | "open" | "closed";
  before: ProviderReadback; evidence?: Record<string, CellEvidence>;
  after?: ProviderReadback; afterHash?: string;
  createdAt: string; verifiedAt?: string; workspaceVersion: number };
const receiptKey = (grantId: string, operationKey: string) => `source:inventory-operation:${grantId}:${operationKey}`;
function uuid(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value)) throw Error("INVALID_INPUT");
  return value;
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) !== value) throw Error("INVALID_INPUT");
  return value;
}
function exact(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)))
    throw Error("INVALID_INPUT");
}
function nights(checkIn: string, checkOut: string, roomIds: string[]) {
  const days: string[] = [];
  for (let t = Date.parse(`${checkIn}T00:00:00Z`); t < Date.parse(`${checkOut}T00:00:00Z`); t += 86400000)
    days.push(new Date(t).toISOString().slice(0,10));
  if (!days.length || days.length > 31 || days.length * roomIds.length > 100) throw Error("INVALID_INPUT");
  return new Set(roomIds.flatMap(roomId => days.map(date => `${roomId}|${date}`)));
}
function providerReadback(value: unknown, expected: Set<string>, now: Date, minTime: number,
  partial = false): ProviderReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("INVALID_INPUT");
  const input = value as Record<string, unknown>;
  exact(input, ["observedAt", "sourceVersion", "cells"]);
  if (typeof input.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.observedAt) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    Date.parse(input.observedAt) < minTime || Date.parse(input.observedAt) > now.getTime() + 30000 ||
    typeof input.sourceVersion !== "string" || !VERSION.test(input.sourceVersion) ||
    !Array.isArray(input.cells) || input.cells.length < 1 ||
    (partial ? input.cells.length > expected.size : input.cells.length !== expected.size))
    throw Error("SOURCE_READBACK_REQUIRED");
  const seen = new Set<string>();
  const cells = input.cells.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("INVALID_INPUT");
    const cell = raw as Record<string, unknown>;
    exact(cell, ["roomId", "date", "count", "isLock"]);
    const roomId = uuid(cell.roomId), day = date(cell.date), key = `${roomId}|${day}`;
    if (!expected.has(key) || seen.has(key) || !Number.isSafeInteger(cell.count) || Number(cell.count) < 0 ||
      Number(cell.count) > 100 || typeof cell.isLock !== "boolean") throw Error("SOURCE_READBACK_REQUIRED");
    seen.add(key);
    return { roomId, date: day, count: cell.count as number, isLock: cell.isLock as boolean };
  });
  return { observedAt: input.observedAt, sourceVersion: input.sourceVersion, cells };
}
function output(receipt: Receipt) {
  const evidence = Object.values(receipt.evidence ?? {})
    .filter(row => typeof row.nightOperationKey === "string" && VERSION.test(row.nightOperationKey) &&
      Number.isSafeInteger(row.recordedWorkspaceVersion) && row.recordedWorkspaceVersion > 0)
    .sort((a, b) =>
      `${a.cell.roomId}|${a.cell.date}`.localeCompare(`${b.cell.roomId}|${b.cell.date}`))
    .map(row => ({ roomId: row.cell.roomId, date: row.cell.date, count: row.cell.count,
      isLock: row.cell.isLock, observedAt: row.observedAt, sourceVersion: row.sourceVersion,
      nightOperationKey: row.nightOperationKey, recordedWorkspaceVersion: row.recordedWorkspaceVersion,
      evidenceHash: digest(JSON.stringify(row)) }));
  const seen = new Set(evidence.map(row => `${row.roomId}|${row.date}`));
  const missingCells = receipt.before.cells.filter(cell => !seen.has(`${cell.roomId}|${cell.date}`))
    .map(cell => ({ roomId: cell.roomId, date: cell.date }))
    .sort((a, b) => `${a.roomId}|${a.date}`.localeCompare(`${b.roomId}|${b.date}`));
  return { schemaVersion: 1, grantId: receipt.grantId, propertyId: receipt.propertyId,
    operationKey: receipt.operationKey, fenceId: receipt.fenceId, mode: receipt.mode,
    status: receipt.status, workspaceVersion: receipt.workspaceVersion,
    evidence, missingCells, verifiedCells: evidence.length,
    expectedCells: receipt.before.cells.length,
    readyToFinalize: receipt.status === "pending" && missingCells.length === 0,
    fenceBlocksSales: receipt.status !== "open" || missingCells.length > 0,
    createdAt: receipt.createdAt, verifiedAt: receipt.verifiedAt ?? null,
    sourceVersion: receipt.after?.sourceVersion ?? receipt.before.sourceVersion,
    verified: receipt.status !== "pending" && missingCells.length === 0 };
}
export async function inventoryStatus(store: CustomerStore, grantId: unknown,
  authorization: string | null, operationKey: unknown) {
  const id = uuid(grantId), key = uuid(operationKey);
  await authorizedGrant(store, id, authorization);
  const receipt = (await store.read<Receipt>(receiptKey(id, key))).value;
  if (!receipt || receipt.grantId !== id) throw Error("NOT_FOUND");
  return output(receipt);
}
export async function inventoryNight(store: CustomerStore, grantId: unknown, grantVersion: unknown,
  authorization: string | null, propertyId: unknown, roomId: unknown, day: unknown) {
  const id = uuid(grantId), property = uuid(propertyId), room = uuid(roomId), night = date(day);
  const { grant, workspace } = await authorizedGrant(store, id, authorization, grantVersion, true);
  if (grant.provider !== "owlnest" || property !== grant.propertyId ||
    !workspace.properties.find(p => p.id === property)?.rooms.some(r => r.id === room)) throw Error("FORBIDDEN");
  const checkOut = new Date(Date.parse(`${night}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const window = { checkIn: night, checkOut, roomIds: [room] };
  const bookingOccupied = workspace.bookings.some(b => b.propertyId === property &&
    occupiesInventory(b) && bookingsOverlap(b, window));
  const manuallyBlocked = !!workspace.blocks?.some(b => b.propertyId === property &&
    b.status === "active" && bookingsOverlap(b, window));
  const fences = await Promise.all((workspace.integrationFences ?? [])
    .filter(f => f.propertyId === property && bookingsOverlap(f, window)).map(async f => {
      const receipt = (await store.read<Receipt>(receiptKey(f.grantId, f.operationKey))).value;
      const proof = f.grantId === grant.id && receipt?.grantId === grant.id ?
        output(receipt).evidence.find(e => e.roomId === room && e.date === night) : null;
      return { fenceId: f.id, operationKey: f.operationKey, mode: f.mode, state: f.state,
        evidence: proof ?? null };
    }));
  const ready = propertyReadiness(workspace, workspace.properties.find(p => p.id === property)!).complete &&
    !workspace.reviewRecords?.some(r => r.propertyId === property);
  return { schemaVersion: 1, verified: true, accountId: grant.ownerAccountId, workspaceId: workspace.id,
    propertyId: property, roomId: room, date: night, workspaceVersion: workspace.version,
    bookingOccupied, manuallyBlocked, fences, canOpen: ready && !bookingOccupied && !manuallyBlocked && !fences.length };
}
export async function acquireInventoryGuard(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  exact(input, ["schemaVersion", "action", "grantId", "grantVersion", "operationKey", "sourceAccount",
    "expectedWorkspaceVersion", "mode", "checkIn", "checkOut", "roomIds", "closedFenceId", "providerBefore"]);
  if (input.schemaVersion !== 1 || input.action !== "acquire_guard" ||
    !["open","close"].includes(String(input.mode)) || !Number.isSafeInteger(input.expectedWorkspaceVersion))
    throw Error("INVALID_INPUT");
  const grantId = uuid(input.grantId), operationKey = uuid(input.operationKey),
    checkIn = date(input.checkIn), checkOut = date(input.checkOut);
  if (checkIn >= checkOut || !Array.isArray(input.roomIds) || input.roomIds.length < 1 ||
    input.roomIds.length > 30 || input.roomIds.some(id => typeof id !== "string" || !UUID.test(id)) ||
    new Set(input.roomIds).size !== input.roomIds.length ||
    !(input.closedFenceId === null || (input.mode === "open" && typeof input.closedFenceId === "string" && UUID.test(input.closedFenceId))))
    throw Error("INVALID_INPUT");
  const roomIds = input.roomIds as string[], expected = nights(checkIn, checkOut, roomIds);
  const { saved: grantSnapshot, grant } = await authorizedGrant(store, grantId, authorization, input.grantVersion, true);
  if (grant.provider !== "owlnest" || grant.sourceAccount !== input.sourceAccount) throw Error("FORBIDDEN");
  const hash = digest(JSON.stringify(input)), key = receiptKey(grantId, operationKey), previous = await store.read<Receipt>(key);
  if (previous.value) {
    if (previous.value.inputHash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(previous.value);
  }
  const before = providerReadback(input.providerBefore, expected, now, now.getTime()-5*60000);
  await store.limit(`source-inventory:${grant.id}`, 300);
  const wsKey = `workspace:${grant.workspaceId}`, snapshot = await store.read<Workspace>(wsKey), workspace = snapshot.value;
  if (!workspace || !grantOwnerActive(workspace, grant) || workspace.version !== input.expectedWorkspaceVersion)
    throw Error("VERSION_CONFLICT");
  const property = workspace.properties.find(p => p.id === grant.propertyId);
  if (!property || roomIds.some(id => !property.rooms.some(r => r.id === id))) throw Error("INVALID_INPUT");
  if (input.mode === "open" && (!propertyReadiness(workspace, property).complete ||
    workspace.reviewRecords?.some(r => r.propertyId === property.id))) throw Error("IMPORT_INCOMPLETE");
  const window = { checkIn, checkOut, roomIds };
  const overlapping = (workspace.integrationFences ?? []).filter(f => f.propertyId === property.id && bookingsOverlap(f, window));
  const closed = input.closedFenceId === null ? null : overlapping.find(f =>
    f.id === input.closedFenceId && f.state === "closed" && f.grantId === grant.id);
  if (input.closedFenceId !== null && (!closed || closed.checkIn !== checkIn || closed.checkOut !== checkOut ||
    closed.roomIds.length !== roomIds.length || closed.roomIds.some(id => !roomIds.includes(id)))) throw Error("FENCE_CONFLICT");
  if (overlapping.some(f => f.id !== closed?.id) || (input.mode === "close" && overlapping.length)) throw Error("FENCE_CONFLICT");
  if (input.mode === "open" && (workspace.bookings.some(b => b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, window)) ||
    workspace.blocks?.some(b => b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, window))))
    throw Error("ROOM_CONFLICT");
  if ((workspace.integrationFences?.length ?? 0) >= 500) throw Error("LIMIT_REACHED");
  const fence: Fence = { id: randomUUID(), grantId, propertyId: property.id, operationKey, mode: input.mode as "open"|"close",
    state: "pending", checkIn, checkOut, roomIds, createdAt: now.toISOString() };
  const next: Workspace = { ...workspace, version: workspace.version + 1,
    integrationFences: [...(workspace.integrationFences ?? []), fence],
    audit: [...workspace.audit, { at: now.toISOString(), actor: `source:${grant.clientId}`, action: "inventory.guard.acquired", targetId: fence.id }] };
  const receipt: Receipt = { grantId, propertyId: property.id, operationKey, inputHash: hash,
    fenceId: fence.id, mode: fence.mode, closedFenceId: closed?.id ?? null,
    status: "pending", before, createdAt: now.toISOString(), workspaceVersion: next.version };
  try { await store.commit([
    { key: wsKey, before: snapshot.raw, after: next },
    { key, before: null, after: receipt },
    { key: `source:grant:${grant.id}`, before: grantSnapshot.raw, after: grant },
  ]); }
  catch (error) {
    const recovered = (await store.read<Receipt>(key)).value;
    if (!recovered) throw error;
    if (recovered.inputHash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(recovered);
  }
  const readback = (await store.read<Receipt>(key)).value;
  if (!readback || readback.fenceId !== fence.id) throw Error("WRITE_UNCONFIRMED");
  return output(readback);
}
export async function recordInventoryVerified(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  exact(input, ["schemaVersion", "action", "grantId", "grantVersion", "operationKey",
    "nightOperationKey", "expectedWorkspaceVersion", "providerAfter"]);
  if (input.schemaVersion !== 1 || input.action !== "record_verified" ||
    !Number.isSafeInteger(input.expectedWorkspaceVersion) ||
    typeof input.nightOperationKey !== "string" || !VERSION.test(input.nightOperationKey)) throw Error("INVALID_INPUT");
  const grantId = uuid(input.grantId), operationKey = uuid(input.operationKey);
  const { saved: grantSnapshot, grant } = await authorizedGrant(store, grantId, authorization, input.grantVersion, true);
  if (grant.provider !== "owlnest") throw Error("FORBIDDEN");
  const key = receiptKey(grantId, operationKey), saved = await store.read<Receipt>(key), receipt = saved.value;
  if (!receipt || receipt.grantId !== grantId) throw Error("NOT_FOUND");
  const expected = new Set(receipt.before.cells.map(c => `${c.roomId}|${c.date}`));
  const after = providerReadback(input.providerAfter, expected, now,
    Math.max(Date.parse(receipt.createdAt), now.getTime()-5*60000), true);
  if (after.cells.length !== 1) throw Error("SOURCE_READBACK_REQUIRED");
  if (receipt.status !== "pending") return output(receipt);
  if (receipt.mode === "open" ? after.cells.some(c => c.count <= 0 || c.isLock) :
    after.cells.some(c => c.count > 0 && !c.isLock)) throw Error("SOURCE_READBACK_REQUIRED");
  const cell = after.cells[0], cellKey = `${cell.roomId}|${cell.date}`;
  if (Object.values(receipt.evidence ?? {}).some(value => value.nightOperationKey === input.nightOperationKey &&
    `${value.cell.roomId}|${value.cell.date}` !== cellKey)) throw Error("IDEMPOTENCY_CONFLICT");
  const previous = receipt.evidence?.[cellKey];
  if (previous) {
    if (previous.nightOperationKey !== input.nightOperationKey || previous.observedAt !== after.observedAt ||
      previous.sourceVersion !== after.sourceVersion || digest(JSON.stringify(previous.cell)) !== digest(JSON.stringify(cell)))
      throw Error("IDEMPOTENCY_CONFLICT");
    return output(receipt);
  }
  const wsKey = `workspace:${grant.workspaceId}`, snapshot = await store.read<Workspace>(wsKey), workspace = snapshot.value;
  if (!workspace || !grantOwnerActive(workspace, grant)) throw Error("FORBIDDEN");
  if (workspace.version !== input.expectedWorkspaceVersion) throw Error("VERSION_CONFLICT");
  const fence = workspace.integrationFences?.find(f => f.id === receipt.fenceId && f.grantId === grantId && f.state === "pending");
  if (!fence) throw Error("FENCE_CONFLICT");
  const nextWorkspaceVersion = workspace.version + 1;
  const evidence = { ...(receipt.evidence ?? {}), [cellKey]: { cell, observedAt: after.observedAt,
    sourceVersion: after.sourceVersion, nightOperationKey: input.nightOperationKey,
    recordedWorkspaceVersion: nextWorkspaceVersion } };
  const next: Receipt = { ...receipt, evidence, workspaceVersion: nextWorkspaceVersion };
  const nextWorkspace: Workspace = { ...workspace, version: nextWorkspaceVersion,
    audit: [...workspace.audit, { at: now.toISOString(), actor: `source:${grant.clientId}`,
      action: "inventory.night.verified", targetId: receipt.fenceId }] };
  try { await store.commit([
    { key: wsKey, before: snapshot.raw, after: nextWorkspace },
    { key, before: saved.raw, after: next },
    { key: `source:grant:${grant.id}`, before: grantSnapshot.raw, after: grant },
  ]); }
  catch (error) {
    const recovered = (await store.read<Receipt>(key)).value;
    if (!recovered) throw error;
    const seen = recovered.evidence?.[cellKey];
    if (seen && seen.nightOperationKey === input.nightOperationKey && seen.observedAt === after.observedAt &&
      seen.sourceVersion === after.sourceVersion &&
      digest(JSON.stringify(seen.cell)) === digest(JSON.stringify(cell))) return output(recovered);
    throw error;
  }
  const readback = (await store.read<Receipt>(key)).value;
  if (!readback || readback.workspaceVersion !== nextWorkspaceVersion ||
    readback.evidence?.[cellKey]?.nightOperationKey !== input.nightOperationKey)
    throw Error("WRITE_UNCONFIRMED");
  return output(readback);
}

export async function finalizeInventoryGuard(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  exact(input, ["schemaVersion", "action", "grantId", "grantVersion", "operationKey",
    "expectedWorkspaceVersion", "providerAfter"]);
  if (input.schemaVersion !== 1 || input.action !== "finalize_guard" ||
    !Number.isSafeInteger(input.expectedWorkspaceVersion)) throw Error("INVALID_INPUT");
  const grantId = uuid(input.grantId), operationKey = uuid(input.operationKey);
  const { saved: grantSnapshot, grant } = await authorizedGrant(store, grantId, authorization, input.grantVersion, true);
  if (grant.provider !== "owlnest") throw Error("FORBIDDEN");
  const key = receiptKey(grantId, operationKey), saved = await store.read<Receipt>(key), receipt = saved.value;
  if (!receipt || receipt.grantId !== grantId) throw Error("NOT_FOUND");
  const expected = new Set(receipt.before.cells.map(c => `${c.roomId}|${c.date}`));
  const evidence = receipt.evidence ?? {};
  if (Object.keys(evidence).length !== expected.size || Object.keys(evidence).some(k => !expected.has(k)) ||
    output(receipt).missingCells.length !== 0)
    throw Error("SOURCE_READBACK_REQUIRED");
  const latestObserved = Math.max(...Object.values(evidence).map(v => Date.parse(v.observedAt)));
  const after = providerReadback(input.providerAfter, expected, now,
    Math.max(latestObserved, now.getTime()-5*60000));
  if (after.cells.some(cell => {
    const recorded = evidence[`${cell.roomId}|${cell.date}`]?.cell;
    return !recorded || recorded.count !== cell.count || recorded.isLock !== cell.isLock;
  })) throw Error("SOURCE_READBACK_REQUIRED");
  const afterHash = digest(JSON.stringify(after));
  if (receipt.status !== "pending") {
    if (receipt.afterHash !== afterHash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(receipt);
  }
  if (receipt.mode === "open" ? after.cells.some(c => c.count <= 0 || c.isLock) :
    after.cells.some(c => c.count > 0 && !c.isLock)) throw Error("SOURCE_READBACK_REQUIRED");
  const wsKey = `workspace:${grant.workspaceId}`, snapshot = await store.read<Workspace>(wsKey), workspace = snapshot.value;
  if (!workspace || !grantOwnerActive(workspace, grant)) throw Error("FORBIDDEN");
  if (workspace.version !== input.expectedWorkspaceVersion) throw Error("VERSION_CONFLICT");
  const fence = workspace.integrationFences?.find(f => f.id === receipt.fenceId && f.grantId === grantId && f.state === "pending");
  if (!fence) throw Error("FENCE_CONFLICT");
  if (receipt.mode === "open") {
    const property = workspace.properties.find(p => p.id === fence.propertyId);
    if (!property || !propertyReadiness(workspace, property).complete ||
      workspace.reviewRecords?.some(r => r.propertyId === fence.propertyId)) throw Error("IMPORT_INCOMPLETE");
    const window = { checkIn: fence.checkIn, checkOut: fence.checkOut, roomIds: fence.roomIds };
    if (workspace.bookings.some(b => b.propertyId === fence.propertyId && occupiesInventory(b) && bookingsOverlap(b, window)) ||
      workspace.blocks?.some(b => b.propertyId === fence.propertyId && b.status === "active" && bookingsOverlap(b, window)))
      throw Error("ROOM_CONFLICT");
  }
  const finalFences = receipt.mode === "open"
    ? (workspace.integrationFences ?? []).filter(f => f.id !== fence.id && f.id !== receipt.closedFenceId)
    : (workspace.integrationFences ?? []).map(f => f.id === fence.id ?
      { ...f, state: "closed" as const, verifiedAt: now.toISOString() } : f);
  const next: Workspace = { ...workspace, version: workspace.version + 1, integrationFences: finalFences,
    audit: [...workspace.audit, { at: now.toISOString(), actor: `source:${grant.clientId}`,
      action: receipt.mode === "open" ? "inventory.open.verified" : "inventory.close.verified", targetId: fence.id }] };
  const finalReceipt: Receipt = { ...receipt, status: receipt.mode === "open" ? "open" : "closed", after, afterHash,
    verifiedAt: now.toISOString(), workspaceVersion: next.version };
  try { await store.commit([
    { key: wsKey, before: snapshot.raw, after: next },
    { key, before: saved.raw, after: finalReceipt },
    { key: `source:grant:${grant.id}`, before: grantSnapshot.raw, after: grant },
  ]); }
  catch (error) {
    const recovered = (await store.read<Receipt>(key)).value;
    if (!recovered || recovered.status === "pending") throw error;
    if (recovered.afterHash !== afterHash) throw Error("IDEMPOTENCY_CONFLICT");
    return output(recovered);
  }
  const verified = (await store.read<Receipt>(key)).value;
  if (!verified || verified.status !== finalReceipt.status || verified.afterHash !== afterHash) throw Error("WRITE_UNCONFIRMED");
  return output(verified);
}
