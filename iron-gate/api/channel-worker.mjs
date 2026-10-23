import { Pool } from "pg";
import { databaseUrlForVercel } from "./index.mjs";
import { PostgresPropertyRepository } from "../dist/postgres-repository.mjs";
import { IronGateService } from "../dist/service.js";
import { createChannelWorker } from "../dist/channel-worker.mjs";
import { assertRuntimeDatabase } from "../dist/runtime-safety.mjs";
import { checkedOwlNestConfig } from "../dist/owlnest-web-readback.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ERRORS = new Set(["CHANNEL_WORKER_CONFIG_INVALID", "UNSAFE_DATABASE_ROLE_OR_SCHEMA",
  "UNSAFE_DATABASE_TRANSPORT", "CHANNEL_PROPERTY_CLAIMED", "CHANNEL_NOT_READY",
  "OWLNEST_AUTH_EXPIRED", "OWLNEST_READ_FAILED", "OWLNEST_WRITE_OUTCOME_UNKNOWN",
  "OWLNEST_RESPONSE_INCOMPLETE", "CHANNEL_WORKER_PROPERTY_NOT_READY"]);

function response(status, state) {
  return new Response(JSON.stringify({ state }), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  } });
}

/** Bounded one-operation tick. A missing configuration always fails closed. */
export function createChannelWorkerFetch(env = process.env, dependencies = {}) {
  let ready;
  return async (request) => {
    if (request.method !== "GET") return response(405, "method_not_allowed");
    if (env.VERCEL_ENV !== "production" ||
      env.IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED !== "true")
      return response(503, "disabled");
    if (!SECRET.test(env.CRON_SECRET ?? "") ||
      request.headers.get("authorization") !== "Bearer " + env.CRON_SECRET)
      return response(401, "unauthorized");
    try {
      ready ??= (async () => {
        const propertyId = env.IRON_GATE_CHANNEL_PROPERTY_ID;
        const grantId = env.IRON_GATE_CHANNEL_GRANT_ID;
        if (!UUID.test(propertyId ?? "") || !UUID.test(grantId ?? "") ||
          !env.IRON_GATE_PRODUCTION_DATABASE_URL ||
          typeof env.IRON_GATE_CHANNEL_AUTHORIZATION !== "string" ||
          !/^Bearer [A-Za-z0-9._~+\/-]{20,}={0,2}$/.test(
            env.IRON_GATE_CHANNEL_AUTHORIZATION)) throw Error("CHANNEL_WORKER_CONFIG_INVALID");
        let config;
        try { config = JSON.parse(env.IRON_GATE_CHANNEL_OWLNEST_CONFIG_JSON ?? ""); }
        catch { throw Error("CHANNEL_WORKER_CONFIG_INVALID"); }
        checkedOwlNestConfig(propertyId, config?.[propertyId]);
        const databaseUrl = databaseUrlForVercel(env.IRON_GATE_PRODUCTION_DATABASE_URL);
        const pool = dependencies.pool ?? new Pool({ connectionString: databaseUrl,
          max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
        try { await (dependencies.assertRuntimeDatabase ?? assertRuntimeDatabase)(pool); }
        catch (error) {
          if (!dependencies.pool) await pool.end().catch(() => {});
          throw error;
        }
        const repository = dependencies.repository ?? new PostgresPropertyRepository(pool);
        const service = dependencies.service ?? new IronGateService(repository);
        const worker = createChannelWorker({ repository, service,
          propertyConfigs: config,
          getAuthorization: async () => env.IRON_GATE_CHANNEL_AUTHORIZATION,
          provider: dependencies.provider ?? null,
          onReview: async ({ propertyId: id, operationKey, status }) => {
            // Identifiers only. The durable claim and fence remain for manual repair.
            console.error("channel_review", { propertyId: id, operationKey, status });
          } });
        return { propertyId, grantId, repository, worker };
      })().catch((error) => {
        if (error?.message !== "UNSAFE_DATABASE_ROLE_OR_SCHEMA") ready = undefined;
        throw error;
      });
      const { propertyId, grantId, repository, worker } = await ready;
      const state = await repository.read(propertyId);
      if (!state || state.channel?.grantId !== grantId || state.readOnly !== false ||
        state.channel?.mode !== "owlnest" || state.channel?.ready !== true ||
        state.channel?.sourceReadbackEnabled !== true)
        return response(409, "property_not_ready");
      const principal = { clientId: "channel-cron", subjectId: "channel-cron",
        origin: "channel", workspaceId: state.workspaceId,
        propertyIds: [propertyId], authorityEpoch: state.authorityEpoch,
        actions: ["channel:verify"], fields: [], grantId };
      const result = await worker.runOne(principal, propertyId);
      return response(result.state === "review_required" ? 409 : 200, result.state);
    } catch (error) {
      console.error("channel_worker_failed", {
        code: SAFE_ERRORS.has(error?.message) ? error.message : "INTERNAL_ERROR" });
      return response(503, "unavailable");
    }
  };
}

export default { fetch: createChannelWorkerFetch() };
