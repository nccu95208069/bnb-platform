import { after, NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { access } from "@/lib/order-health/access";
import {
  createJob,
  status,
  answer,
  start,
  run,
  reportFor,
  removeSource,
  configured,
  revise,
  chatHistory,
  saveChat,
  retryConnection,
  suggest,
} from "@/lib/order-health/service";
import { parseFile, MAX_BYTES } from "@/lib/order-health/parser";
import { readerEmail } from "@/lib/order-health/google";
import { chat } from "@/lib/order-health/chat";
import { messageFor, messages } from "@/lib/order-health/messages";
import { spreadsheetId } from "@/lib/customer-workspaces/customer-google";
export const runtime = "nodejs";
export const maxDuration = 180;
const store = new RedisCustomerStore(),
  headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Cookie",
    "Referrer-Policy": "no-referrer",
  };
const fail = (error: unknown) => {
  const raw = error instanceof Error ? error.message : "HEALTH_FAILED";
  const code = Object.hasOwn(messages, raw) ? raw : "HEALTH_FAILED";
  return NextResponse.json(
    { error: messageFor(code), code },
    {
      status:
        code === "UNAUTHORIZED"
          ? 401
          : code === "FORBIDDEN"
            ? 403
            : code === "RATE_LIMITED"
              ? 429
              : code === "VERSION_CONFLICT"
                ? 409
                : 400,
      headers,
    },
  );
};
async function scope(r: NextRequest) {
  return access(
    store,
    r,
    r.nextUrl.searchParams.get("workspace") || "legacy",
    r.nextUrl.searchParams.get("property") || "",
  );
}
export async function GET(request: NextRequest) {
  try {
    const s = await scope(request);
    const chatId = request.nextUrl.searchParams.get("chat");
    if (chatId)
      return NextResponse.json(
        { history: await chatHistory(store, s, chatId) },
        { headers },
      );
    const state = await status(
      store,
      s,
      request.nextUrl.searchParams.get("job") || undefined,
    );
    if (
      s.canWrite &&
      state.job &&
      ["checking_access", "awaiting_share", "reading", "analyzing"].includes(state.job.state)
    )
      after(async () => {
        await run(store, s, state.job!.id).catch(() => {});
        await run(store, s, state.job!.id).catch(() => {});
      });
    return NextResponse.json(
      {
        ...state,
        readerEmail: readerEmail(),
        configured: configured(),
        canWrite: s.canWrite,
      },
      { headers },
    );
  } catch (e) {
    return fail(e);
  }
}
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (
      !origin ||
      origin !== request.nextUrl.origin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw Error("FORBIDDEN");
    const s = await scope(request);
    if (!s.canWrite) throw Error("FORBIDDEN");
    if (!configured()) throw Error("HEALTH_UNAVAILABLE");
    await store.limit(`health-action:${s.actor}`, 60);
    const max = request.headers
      .get("content-type")
      ?.includes("multipart/form-data")
      ? MAX_BYTES + 20000
      : 20000;
    if (Number(request.headers.get("content-length")) > max)
      throw Error("HEALTH_SIZE");
    if (!request.body) throw Error("INVALID_INPUT");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw Error("HEALTH_SIZE");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    let job;
    if (request.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await new Response(body, {
          headers: { "Content-Type": request.headers.get("content-type")! },
        }).formData(),
        file = form.get("file");
      if (!(file instanceof File)) throw Error("INVALID_INPUT");
      job = await createJob(store, s, {
        requestId: String(form.get("requestId") || ""),
        title: file.name,
        tables: await parseFile(
          Buffer.from(await file.arrayBuffer()),
          file.name,
        ),
      });
    } else {
      const input = JSON.parse(body.toString());
      if (input.action === "sheet") {
        if (typeof input.url !== "string" || input.url.length > 500)
          throw Error("INVALID_INPUT");
        spreadsheetId(input.url);
        job = await createJob(store, s, {
          requestId: input.requestId,
          title: "Google 試算表",
          url: input.url,
        });
      } else if (input.action === "check_access")
        job = await retryConnection(store, s, input.id);
      else if (input.action === "suggest") {
        return NextResponse.json(await suggest(store, s, input.id, input.question), { headers });
      }
      else if (input.action === "answer")
        job = await answer(store, s, input.id, input.answers, input.version);
      else if (input.action === "start")
        job = await start(store, s, input.id, input.version);
      else if (input.action === "revise")
        job = await revise(store, s, input.id, input.requestId);
      else if (input.action === "chat") {
        await store.limit(`health-chat:${s.actor}`, 20);
        const result = await chat(
          await reportFor(store, s, input.id),
          input.message,
          input.chart,
          input.filter,
          await chatHistory(store, s, input.id),
        );
        await saveChat(store, s, input.id, {
          question: input.message,
          answer: result.answer,
          facts: result.facts,
          snapshot: result.snapshot,
          mode: result.mode,
          context: result.context,
          intent: result.intent,
          createdAt: new Date().toISOString(),
        });
        return NextResponse.json(result, { headers });
      } else if (input.action === "delete-source") {
        await removeSource(store, s, input.id);
        return NextResponse.json({ deleted: true }, { headers });
      } else throw Error("INVALID_INPUT");
    }
    if (["checking_access", "awaiting_share", "reading", "analyzing"].includes(job.state))
      after(async () => {
        await run(store, s, job.id).catch(() => {});
        await run(store, s, job.id).catch(() => {});
      });
    return NextResponse.json({ job }, { headers });
  } catch (e) {
    return fail(e);
  }
}
