/**
 * OS membership is checked on every request by an independently injected
 * verifier. Without it, an OS credential never authenticates.
 */
import { validateGrantShape } from "./credential-grant.mjs";

export function createGrantAuthenticator(directory, repository, verifyOsMember = null,
  verifyLineOperator = null) {
  return async (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
    if (!match) return null;
    const grant = await directory.lookup(match[1]);
    if (!grant) return null;
    try { validateGrantShape(grant); }
    catch { return null; }
    const state = await repository.read(grant.propertyId);
    if (!state || state.workspaceId !== grant.workspaceId ||
      state.authorityEpoch !== grant.authorityEpoch) return null;
    let subjectId = grant.subjectId;
    let allowedActions = grant.actions;
    let allowedFields = grant.fields;
    if (grant.origin === "os") {
      if (!verifyOsMember) return null;
      const member = await verifyOsMember(request, grant);
      if (!member || member.workspaceId !== grant.workspaceId ||
        typeof member.subjectId !== "string" || !member.subjectId ||
        !Array.isArray(member.propertyIds) || !member.propertyIds.includes(grant.propertyId) ||
        !Array.isArray(member.actions) || !Array.isArray(member.fields)) return null;
      subjectId = member.subjectId;
      allowedActions = grant.actions.filter((action) => member.actions?.includes(action));
      allowedFields = grant.fields.filter((field) => member.fields?.includes(field));
    }
    if (grant.origin === "line") {
      if (!verifyLineOperator) return null;
      const operator = await verifyLineOperator(request, grant);
      if (!operator || operator.workspaceId !== grant.workspaceId ||
        operator.groupId !== grant.lineGroupId ||
        typeof operator.subjectId !== "string" || !operator.subjectId ||
        !Array.isArray(operator.propertyIds) ||
        !operator.propertyIds.includes(grant.propertyId) ||
        !Array.isArray(operator.actions) || !Array.isArray(operator.fields)) return null;
      subjectId = operator.subjectId;
      allowedActions = grant.actions.filter((action) => operator.actions.includes(action));
      allowedFields = grant.fields.filter((field) => operator.fields.includes(field));
    }
    return { clientId: grant.clientId, subjectId, origin: grant.origin,
      workspaceId: grant.workspaceId, propertyIds: [grant.propertyId],
      authorityEpoch: grant.authorityEpoch, actions: allowedActions, fields: allowedFields,
      grantId: grant.grantId, bindingId: grant.bindingId,
      bookingIdScope: grant.bookingIdScope, sourceSystem: grant.sourceSystem,
      sourceAccount: grant.sourceAccount,
      financeSourceInstanceId: grant.financeSourceInstanceId,
      financeGeneralEntriesOnly: grant.financeGeneralEntriesOnly };
  };
}
