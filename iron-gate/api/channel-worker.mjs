import { Pool } from "pg";
import { databaseUrlForVercel } from "./index.mjs";
import { PostgresPropertyRepository } from "../dist/postgres-repository.mjs";
import { IronGateService } from "../dist/service.js";
import { createChannelWorker } from "../dist/channel-worker.mjs";
import { assertRuntimeDatabase } from "../dist/runtime-safety.mjs";
import { boundedOwlNestJson, checkedOwlNestConfig } from "../dist/owlnest-web-readback.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SAFE_ERRORS = new Set(["CHANNEL_WORKER_CONFIG_INVALID", "UNSAFE_DATABASE_ROLE_OR_SCHEMA",
  "UNSAFE_DATABASE_TRANSPORT", "CHANNEL_PROPERTY_CLAIMED", "CHANNEL_NOT_READY",
  "OWLNEST_AUTH_EXPIRED", "OWLNEST_READ_FAILED", "OWLNEST_WRITE_OUTCOME_UNKNOWN",
  "OWLNEST_RESPONSE_INCOMPLETE", "CHANNEL_WORKER_PROPERTY_NOT_READY",
  "CHANNEL_ALERT_UNAVAILABLE", "CHANNEL_AUTH_UNAVAILABLE"]);

/** Fetch a new owner login through the protected GCO broker on every cron tick.
 * Short in-flight caching avoids repeated logins for one operation's GET/PUT/GET.
 */
export function createFreshChannelAuthorization({ url, token, propertyId: allowedPropertyId,
  fetchImpl = fetch,
  now = () => Date.now() }) {
  let cached = null, cachedAt = 0, pending = null;
  return async (propertyId) => {
    if (propertyId !== allowedPropertyId) throw Error("CHANNEL_AUTH_UNAVAILABLE");
    if (cached && now() - cachedAt < 120_000) return cached;
    pending ??= (async () => {
      let response;
      try {
        response = await fetchImpl(url, { method: "POST", cache: "no-store",
          redirect: "error", signal: AbortSignal.timeout(55_000),
          headers: { authorization: "Bearer " + token,
            "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ propertyId }) });
        if (!response?.ok) throw Error("CHANNEL_AUTH_UNAVAILABLE");
        const result = await boundedOwlNestJson(response, 1024);
        if (!result || Object.keys(result).join(",") !== "authorization" ||
          typeof result.authorization !== "string" ||
          !/^Bearer [A-Za-z0-9._~+\/-]{20,}={0,2}$/.test(result.authorization))
          throw Error("CHANNEL_AUTH_UNAVAILABLE");
        cached = result.authorization;
        cachedAt = now();
        return cached;
      } catch {
        throw Error("CHANNEL_AUTH_UNAVAILABLE");
      } finally {
        pending = null;
      }
    })();
    return pending;
  };
}

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
        let alertUrl, authUrl;
        try { alertUrl = new URL(env.IRON_GATE_CHANNEL_ALERT_URL ?? ""); }
        catch { throw Error("CHANNEL_WORKER_CONFIG_INVALID"); }
        try { authUrl = new URL(env.IRON_GATE_CHANNEL_AUTH_URL ?? ""); }
        catch { throw Error("CHANNEL_WORKER_CONFIG_INVALID"); }
        if (!UUID.test(propertyId ?? "") || !UUID.test(grantId ?? "") ||
          !env.IRON_GATE_PRODUCTION_DATABASE_URL ||
          alertUrl.protocol !== "https:" || !alertUrl.hostname || alertUrl.port ||
          alertUrl.username || alertUrl.password || alertUrl.search || alertUrl.hash ||
          alertUrl.pathname !== "/internal/iron-gate-channel-alert" ||
          authUrl.protocol !== "https:" || authUrl.origin !== alertUrl.origin ||
          authUrl.username || authUrl.password || authUrl.search || authUrl.hash ||
          authUrl.pathname !== "/internal/iron-gate-channel-auth" ||
          !SECRET.test(env.IRON_GATE_CHANNEL_ALERT_TOKEN ?? "") ||
          env.IRON_GATE_CHANNEL_ALERT_TOKEN === env.CRON_SECRET ||
          !SECRET.test(env.IRON_GATE_CHANNEL_AUTH_TOKEN ?? "") ||
          env.IRON_GATE_CHANNEL_AUTH_TOKEN === env.CRON_SECRET ||
          env.IRON_GATE_CHANNEL_AUTH_TOKEN === env.IRON_GATE_CHANNEL_ALERT_TOKEN)
          throw Error("CHANNEL_WORKER_CONFIG_INVALID");
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
        const getAuthorization = createFreshChannelAuthorization({ url: authUrl,
          token: env.IRON_GATE_CHANNEL_AUTH_TOKEN, propertyId,
          fetchImpl: dependencies.authFetch ?? fetch });
        const worker = createChannelWorker({ repository, service,
          propertyConfigs: config,
          getAuthorization,
          provider: dependencies.provider ?? null,
          onReview: async ({ propertyId: id, operationKey, status }) => {
            // Identifiers only. The durable claim and fence remain for repair.
            console.error("channel_review", { propertyId: id, operationKey, status });
            let delivered;
            try {
              delivered = await (dependencies.alertFetch ?? fetch)(alertUrl, {
                method: "POST", cache: "no-store", redirect: "error",
                signal: AbortSignal.timeout(8000),
                headers: { authorization: "Bearer " + env.IRON_GATE_CHANNEL_ALERT_TOKEN,
                  "content-type": "application/json" },
                body: JSON.stringify({ propertyId: id, operationKey, status }),
              });
            } catch {
              console.error("channel_alert_failed", { propertyId: id, operationKey });
              throw Error("CHANNEL_ALERT_UNAVAILABLE");
            }
            if (!delivered?.ok) {
              console.error("channel_alert_failed", { propertyId: id, operationKey });
              throw Error("CHANNEL_ALERT_UNAVAILABLE");
            }
          } });
        return { propertyId, grantId, repository, worker, alertUrl };
      })().catch((error) => {
        if (error?.message !== "UNSAFE_DATABASE_ROLE_OR_SCHEMA") ready = undefined;
        throw error;
      });
      const { propertyId, grantId, repository, worker, alertUrl } = await ready;
      const state = await repository.read(propertyId);
      if (!state || state.channel?.grantId !== grantId || state.readOnly !== false ||
        state.channel?.mode !== "owlnest" || state.channel?.ready !== true ||
        state.channel?.sourceReadbackEnabled !== true)
        return response(409, "property_not_ready");
      const principal = { clientId: "channel-cron", subjectId: "channel-cron",
        origin: "channel", workspaceId: state.workspaceId,
        propertyIds: [propertyId], authorityEpoch: state.authorityEpoch,
        actions: ["channel:verify"], fields: [], grantId };
      if (env.IRON_GATE_CHANNEL_NOTICE_RETRY_ENABLED === "true") {
        const retryUrl = new URL(alertUrl);
        retryUrl.pathname = "/internal/iron-gate-channel-alert-retry";
        try {
          const retry = await (dependencies.alertFetch ?? fetch)(retryUrl, {
            method: "POST", cache: "no-store", redirect: "error",
            signal: AbortSignal.timeout(8000),
            headers: { authorization: "Bearer " + env.IRON_GATE_CHANNEL_ALERT_TOKEN,
              "content-type": "application/json" }, body: "{}",
          });
          if (!retry?.ok) console.error("channel_notice_retry_failed", { propertyId });
        } catch { console.error("channel_notice_retry_failed", { propertyId }); }
      }
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
