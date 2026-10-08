import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import { OwnerConnection } from "../src/components/website-booking/owner-connection.tsx";
import { mount } from "./helpers/customer-dom.mjs";

const connectionId = "38108691-d4f6-4f23-90d3-2342f562117a";
const roomA = "38108691-d4f6-4f23-90d3-2342f562117b";
const roomB = "38108691-d4f6-4f23-90d3-2342f562117c";
function ownerView() {
  return {
    authenticated: true,
    email: "owner@example.test",
    connection: {
      id: connectionId,
      siteName: "測試旅宿",
      state: "awaiting_owner",
      configurationHash: "a".repeat(64),
      expiresAt: "2099-10-07T12:00:00.000Z",
      config: {
        sellingMode: "mixed",
        opensOn: "2099-10-01",
        closesOn: "2099-12-31",
        wholeHouseNightly: "6000",
        transferInstructions: "請依訂房確認信安排付款。\n<script>unsafe()</script>",
        cancellationPolicy: "請於入住前聯絡修改或取消。",
        rooms: [{ roomTypeId: "double", enabled: true, units: "2", capacity: "2", nightly: "2500" }],
      },
      roomRecords: [{ id: "double", name: "雙人房" }],
    },
    workspaces: [{
      slug: "existing-house",
      name: "原有工作區",
      version: 7,
      properties: [{ id: "property-one", name: "第一館", kind: "mixed", rooms: [{ id: roomA, name: "101" }, { id: roomB, name: "102" }] }],
    }],
  };
}
function connected(view = ownerView()) {
  return { ...view, connection: { ...view.connection, state: "connected", calendarUrl: "/w/isolated-house/calendar" } };
}
async function mountOwner(t) {
  return mount(t, OwnerConnection, { connectionId }, `?connection=${connectionId}`);
}
const confirmation = () => document.querySelector("input[type=checkbox]");

test("invalid links do not request owner data or offer confirmation", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (...args) => { calls.push(args); return Response.json(ownerView()); });
  await mount(t, OwnerConnection, { connectionId: "not-a-uuid" });
  assert.equal(calls.length, 0);
  assert.match(document.body.textContent, /連接網址不完整/);
  assert.equal(document.querySelector("form"), null);
});

test("email login prepares proof first, retains the connection and safely retries an unknown send", async (t) => {
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json({ authenticated: false });
    const body = JSON.parse(options.body);
    posts.push(body);
    if (body.action === "login-prepare") return Response.json({ prepared: true });
    if (posts.length === 2) throw new Error("連線中斷");
    return Response.json({ detail: "如果信箱符合，我們已寄出登入連結。" });
  });
  const { button, control, fill, click } = await mountOwner(t);
  await fill(control("業主 Email"), "owner@example.test");
  await click(button("寄送登入連結"));
  assert.equal(posts[0].action, "login-prepare");
  assert.equal(posts[1].connectionId, connectionId);
  assert.match(posts[1].requestKey, /^[a-f0-9-]{36}$/);
  assert.equal(control("業主 Email").disabled, true);
  await click(button("確認原寄信請求"));
  assert.deepEqual(posts[2], posts[1]);
  assert.equal(posts.filter((p) => p.action === "login-prepare").length, 1);
  assert.equal(location.search, `?connection=${connectionId}`);
  assert.match(document.body.textContent, /已寄出登入連結/);
});

test("owner reviews visible policy text and explicitly confirms before an authoritative readback", async (t) => {
  const posts = [];
  let state = ownerView();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    posts.push(JSON.parse(options.body));
    state = connected(state);
    return Response.json({ state: "connected", calendarUrl: "/w/isolated-house/calendar" });
  });
  const { button, control, fill, click } = await mountOwner(t);
  assert.equal(confirmation().checked, false);
  assert.equal(button("確認並連接日曆").disabled, true);
  assert.match(document.body.textContent, /2 間實體房間/);
  assert.match(document.body.textContent, /每房最多 2 人/);
  assert.match(document.body.textContent, /2099-10-01 至 2099-12-31/);
  assert.match(document.body.textContent, /<script>unsafe\(\)<\/script>/);
  assert.equal(document.querySelector("script"), null);
  await fill(control("日曆網址代稱"), "isolated-house");
  assert.equal(button("確認並連接日曆").disabled, true);
  await click(confirmation());
  await click(button("確認並連接日曆"));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].mode, "new");
  assert.equal(posts[0].confirmed, true);
  assert.equal(posts[0].slug, "isolated-house");
  assert.equal("price" in posts[0], false);
  assert.equal("tenant" in posts[0], false);
  assert.match(document.body.textContent, /已連接 OS 日曆/);
  assert.equal(document.querySelector("a").getAttribute("href"), "/w/isolated-house/calendar");
});

test("a lost response locks edits and retries the exact request even after a pending readback", async (t) => {
  const posts = [];
  let state = ownerView();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    const body = JSON.parse(options.body);
    posts.push(body);
    if (posts.length === 1) throw new Error("連線中斷");
    state = connected(state);
    return Response.json({ state: "connected" });
  });
  const { button, control, fill, click } = await mountOwner(t);
  await fill(control("日曆網址代稱"), "isolated-house");
  await click(confirmation());
  await click(button("確認並連接日曆"));
  assert.equal(control("日曆網址代稱").matches(":disabled"), true);
  assert.equal(confirmation().disabled, true);
  assert.match(document.body.textContent, /送出結果尚未確認/);
  await click(button("查詢連接結果"));
  assert.equal(posts.length, 1);
  assert.equal(control("日曆網址代稱").matches(":disabled"), true);
  await click(button("重試原確認"));
  assert.deepEqual(posts[1], posts[0]);
  assert.match(document.body.textContent, /已連接 OS 日曆/);
});

test("a successful write with failed verification does not claim completion; status lookup recovers without another write", async (t) => {
  let wrote = false;
  let failedRead = false;
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.body) { wrote = true; count++; return Response.json({ state: "connected" }); }
    if (wrote && !failedRead) { failedRead = true; throw new Error("無法讀回"); }
    return Response.json(wrote ? connected() : ownerView());
  });
  const { button, control, fill, click } = await mountOwner(t);
  await fill(control("日曆網址代稱"), "isolated-house");
  await click(confirmation());
  await click(button("確認並連接日曆"));
  assert.doesNotMatch(document.body.textContent, /已連接 OS 日曆/);
  assert.match(document.body.textContent, /送出結果尚未確認/);
  await click(button("查詢連接結果"));
  assert.equal(count, 1);
  assert.match(document.body.textContent, /已連接 OS 日曆/);
});

test("existing properties require explicit unique physical-room mapping and send the workspace version", async (t) => {
  let sent;
  let state = ownerView();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    sent = JSON.parse(options.body);
    state = connected();
    return Response.json({ state: "connected" });
  });
  const { button, control, fill, click } = await mountOwner(t);
  await click(button("使用既有日曆"));
  await fill(control("旅宿工作區"), "existing-house");
  await fill(control("館別"), "property-one");
  const first = control("雙人房：第 1 間"), second = control("雙人房：第 2 間");
  assert.equal(first.value, "");
  assert.equal(second.value, "");
  await fill(first, roomA);
  assert.equal([...second.options].find((o) => o.value === roomA).disabled, true);
  await fill(second, roomA);
  await click(confirmation());
  assert.equal(button("確認並連接日曆").disabled, true);
  await fill(second, roomB);
  assert.equal(confirmation().checked, false);
  await click(confirmation());
  await click(button("確認並連接日曆"));
  assert.equal(sent.mode, "existing");
  assert.equal(sent.propertyId, "property-one");
  assert.equal(sent.version, 7);
  assert.deepEqual(sent.roomMappings, [{ roomTypeId: "double", roomIds: [roomA, roomB] }]);
});

test("reconfiguration preserves the bound property and cannot silently alter the physical room pool", async (t) => {
  const state = ownerView();
  state.connection.binding = { slug: "existing-house", propertyId: "property-one", version: 7, roomMappings: [{ roomTypeId: "double", roomIds: [roomA] }] };
  t.mock.method(globalThis, "fetch", async () => Response.json(state));
  const { button, control, click } = await mountOwner(t);
  assert.equal(control("旅宿工作區").matches(":disabled"), true);
  assert.equal(control("館別").matches(":disabled"), true);
  assert.equal(button("建立全新日曆"), undefined);
  assert.match(document.body.textContent, /新的房型或實體房間數與既有綁定不符/);
  await click(confirmation());
  assert.equal(button("確認並套用新設定").disabled, true);
});

test("an already completed connection is recovered on reload and rejects an unsafe calendar URL", async (t) => {
  const state = connected();
  state.connection.calendarUrl = "https://unrelated.example/calendar";
  const methods = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { methods.push(options.method); return Response.json(state); });
  await mountOwner(t);
  assert.deepEqual(methods, ["GET"]);
  assert.match(document.body.textContent, /已連接 OS 日曆/);
  assert.equal(document.querySelector("form"), null);
  assert.equal(document.querySelector("a"), null);
});

test("rapid double submit uses one in-flight request", async (t) => {
  let resolvePost;
  let count = 0;
  let state = ownerView();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    count++;
    return new Promise((resolve) => { resolvePost = resolve; });
  });
  const { button, control, fill, click, dom } = await mountOwner(t);
  await fill(control("日曆網址代稱"), "isolated-house");
  await click(confirmation());
  const form = button("確認並連接日曆").form;
  await act(() => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(count, 1);
  state = connected();
  await act(() => resolvePost(Response.json({ state: "connected" })));
  assert.match(document.body.textContent, /已連接 OS 日曆/);
});

test("rapid login submits do not rotate browser proof twice", async (t) => {
  const posts = [];
  let finishPrepare;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json({ authenticated: false });
    const body = JSON.parse(options.body);
    posts.push(body);
    if (body.action === "login-prepare") return new Promise((resolve) => { finishPrepare = resolve; });
    return Response.json({ detail: "請查看信箱。" });
  });
  const { button, control, fill, dom } = await mountOwner(t);
  await fill(control("業主 Email"), "owner@example.test");
  const form = button("寄送登入連結").form;
  await act(() => {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  });
  assert.equal(posts.length, 1);
  await act(() => finishPrepare(Response.json({ prepared: true })));
  assert.deepEqual(posts.map((p) => p.action), ["login-prepare", "login-request"]);
});

test("disabling a bound room type cannot silently shrink the existing room pool", async (t) => {
  const state = ownerView();
  state.connection.config.rooms[0].units = "1";
  state.connection.config.rooms.push({ roomTypeId: "single", enabled: false, units: "1", capacity: "1", nightly: "1000" });
  state.connection.binding = { slug: "existing-house", propertyId: "property-one", version: 7, roomMappings: [{ roomTypeId: "double", roomIds: [roomA] }, { roomTypeId: "single", roomIds: [roomB] }] };
  t.mock.method(globalThis, "fetch", async () => Response.json(state));
  const { button, click } = await mountOwner(t);
  await click(confirmation());
  assert.match(document.body.textContent, /新的房型或實體房間數與既有綁定不符/);
  assert.equal(button("確認並套用新設定").disabled, true);
});

test("a different signed-in account can request the intended owner's login without leaving this connection", async (t) => {
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json({ code: "WEBSITE_OWNER_MISMATCH", detail: "請使用指定的業主信箱登入。" }, { status: 403 });
    const body = JSON.parse(options.body);
    posts.push(body);
    return Response.json(body.action === "login-prepare" ? { ok: true } : { detail: "登入連結已申請。" });
  });
  const { button, control, fill, click } = await mountOwner(t);
  assert.match(document.body.textContent, /請使用指定的業主信箱登入/);
  await fill(control("業主 Email"), "owner@example.test");
  await click(button("寄送登入連結"));
  assert.equal(posts[1].connectionId, connectionId);
  assert.equal(posts[1].email, "owner@example.test");
  assert.equal(document.querySelector('a[href="/start"]'), null);
});

const pairingId = "ad5f42c5-1217-4b71-90af-85864a646293";
const pairingToken = "synthetic-onetime-pairing-token-not-a-real-secret";
const pairingInstruction = () => ({
  pairingId,
  pairingToken,
  command: `連接OS ${pairingToken}`,
  expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
});
function lineConnectedView(isConnected = false, id = undefined) {
  const view = connected();
  view.connection.binding = {
    slug: "existing-house",
    propertyId: "property-one",
    version: 7,
    roomMappings: [{ roomTypeId: "double", roomIds: [roomA, roomB] }],
    lineConnected: isConnected,
    ...(id ? { linePairingId: id, lineVerifiedAt: new Date().toISOString() } : {}),
  };
  return view;
}

test("LINE pairing is unavailable until the owner calendar connection is complete", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(ownerView()));
  const { button } = await mountOwner(t);
  assert.equal(button("取得 LINE 配對指令"), undefined);
  assert.equal(button("重新配對 LINE"), undefined);
  assert.doesNotMatch(document.body.textContent, /業主 LINE 通知/);
});

test("unpaired owners explicitly obtain and copy a one-time command without storing it or supplying a LINE recipient", async (t) => {
  const posts = [], clipboard = [];
  let getCount = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) { getCount++; return Response.json(lineConnectedView()); }
    posts.push(JSON.parse(options.body));
    return Response.json(pairingInstruction());
  });
  const { button, control, click, dom } = await mountOwner(t);
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => { clipboard.push(text); } },
  });
  assert.match(document.body.textContent, /LINE 尚未配對/);
  assert.equal(posts.length, 0);
  assert.equal(document.querySelector("input"), null);
  await click(button("取得 LINE 配對指令"));
  assert.deepEqual(Object.keys(posts[0]).sort(), ["action", "connectionId", "requestKey"]);
  assert.equal(posts[0].action, "line-prepare");
  assert.equal(posts[0].connectionId, connectionId);
  assert.match(posts[0].requestKey, /^[0-9a-f-]{36}$/);
  assert.equal(control("LINE 配對指令").readOnly, true);
  assert.equal(control("LINE 配對指令").value, `連接OS ${pairingToken}`);
  assert.match(document.body.textContent, /一對一 LINE 私訊/);
  assert.match(document.body.textContent, /不支援群組/);
  assert.doesNotMatch(document.body.textContent, /本次 LINE 配對完成/);
  assert.equal(button("取得 LINE 配對指令"), undefined);
  await act(async () => {
    button("複製指令").click();
    await Promise.resolve();
  });
  assert.deepEqual(clipboard, [`連接OS ${pairingToken}`]);
  assert.match(document.body.textContent, /已複製，請貼至訂房小助手的一對一 LINE 私訊/);
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
  assert.equal(location.search, `?connection=${connectionId}`);
  assert.equal(location.hash, "");
  assert.equal(getCount, 1);
});

test("an unknown LINE preparation reuses the same request and only a matching server pairing ID completes it", async (t) => {
  const posts = [];
  let state = lineConnectedView();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    posts.push(JSON.parse(options.body));
    if (posts.length === 1) throw new Error("連線中斷");
    return Response.json(pairingInstruction());
  });
  const { button, control, click } = await mountOwner(t);
  await click(button("取得 LINE 配對指令"));
  assert.match(document.body.textContent, /取得配對指令的結果尚未確認/);
  assert.equal(button("取得 LINE 配對指令"), undefined);
  await click(button("重新查詢配對狀態"));
  assert.equal(posts.length, 1);
  assert.doesNotMatch(document.body.textContent, /本次 LINE 配對完成/);
  await click(button("取回原配對指令"));
  assert.deepEqual(posts[1], posts[0]);
  assert.equal(control("LINE 配對指令").value, `連接OS ${pairingToken}`);
  state = lineConnectedView(true, pairingId);
  await click(button("重新查詢配對狀態"));
  assert.match(document.body.textContent, /本次 LINE 配對完成/);
  assert.equal(control("LINE 配對指令"), undefined);
  assert.equal(button("複製指令"), undefined);
  assert.equal(posts.length, 2);
});

test("re-pairing preserves the existing connection and does not claim the new code was consumed from a boolean alone", async (t) => {
  let state = lineConnectedView(true, "08003509-29d9-40da-a807-3e74a0d46012");
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(state);
    posts.push(JSON.parse(options.body));
    return Response.json(pairingInstruction());
  });
  const { button, control, click } = await mountOwner(t);
  assert.match(document.body.textContent, /LINE 已配對/);
  assert.equal(posts.length, 0);
  await click(button("重新配對 LINE"));
  assert.match(document.body.textContent, /既有 LINE 維持連接，新配對待完成/);
  await click(button("重新查詢配對狀態"));
  assert.doesNotMatch(document.body.textContent, /本次 LINE 配對完成/);
  assert.ok(control("LINE 配對指令"));
  state = lineConnectedView(true, pairingId);
  await click(button("重新查詢配對狀態"));
  assert.match(document.body.textContent, /本次 LINE 配對完成/);
  assert.equal(control("LINE 配對指令"), undefined);
  await click(button("重新配對 LINE"));
  assert.equal(posts.length, 2);
  assert.notEqual(posts[1].requestKey, posts[0].requestKey);
});

test("failed LINE status reads preserve pending instructions without reporting pairing completion", async (t) => {
  let readCount = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.body) return Response.json(pairingInstruction());
    if (++readCount > 1) throw new Error("無法讀回配對狀態");
    return Response.json(lineConnectedView());
  });
  const { button, control, click } = await mountOwner(t);
  await click(button("取得 LINE 配對指令"));
  await click(button("重新查詢配對狀態"));
  assert.match(document.body.textContent, /無法讀回配對狀態/);
  assert.doesNotMatch(document.body.textContent, /本次 LINE 配對完成/);
  assert.equal(control("LINE 配對指令").value, `連接OS ${pairingToken}`);
});

test("expired LINE instructions require an explicit new request", async (t) => {
  const posts = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (!options.body) return Response.json(lineConnectedView());
    posts.push(JSON.parse(options.body));
    return Response.json({ ...pairingInstruction(), expiresAt: posts.length === 1 ? new Date(Date.now() - 1000).toISOString() : pairingInstruction().expiresAt });
  });
  const { button, click, dom } = await mountOwner(t);
  await click(button("取得 LINE 配對指令"));
  assert.match(document.body.textContent, /指令已過期/);
  assert.equal(button("複製指令"), undefined);
  await click(button("產生新的配對指令"));
  assert.notEqual(posts[1].requestKey, posts[0].requestKey);
  assert.equal(dom.window.localStorage.length, 0);
  assert.equal(dom.window.sessionStorage.length, 0);
});

test("reloaded paired owners see only the server confirmation and must explicitly request re-pairing", async (t) => {
  const methods = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    methods.push(options.method);
    return Response.json(lineConnectedView(true, pairingId));
  });
  const { button } = await mountOwner(t);
  assert.deepEqual(methods, ["GET"]);
  assert.match(document.body.textContent, /LINE 已配對/);
  assert.doesNotMatch(document.body.textContent, /本次 LINE 配對完成/);
  assert.equal(document.querySelector("textarea"), null);
  assert.ok(button("重新配對 LINE"));
});
