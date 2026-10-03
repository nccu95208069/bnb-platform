import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { CalendarImport } from "../src/components/customer-workspaces/calendar-import.tsx";
import { EmailSignIn } from "../src/components/customer-workspaces/email-signin.tsx";
import { PasswordlessLogin } from "../src/components/customer-workspaces/passwordless-login.tsx";
import { ServiceJoin } from "../src/components/customer-intake/service-join.tsx";
import { fixture, ics, event, range } from "./helpers/calendar-fixture.mjs";
import {
  startCalendarOnboarding,
  draftHash,
  draftForHash,
  previewContext,
  updateCalendarDraft,
  calendarOnboardingView,
  prepareCalendarSave,
  finishCalendarOnboarding,
} from "../src/lib/customer-workspaces/calendar-onboarding.ts";
import {
  uploadCalendar,
  previewCalendar,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import {
  requestEmailLogin,
  consumeEmailLogin,
  newLoginProof,
} from "../src/lib/customer-workspaces/passwordless.ts";
async function mount(t) {
  const dom = new JSDOM('<div id="root"></div>', {
      url: "https://service.test/join",
    }),
    original = {};
  for (const k of [
    "window",
    "document",
    "sessionStorage",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    original[k] = globalThis[k];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    sessionStorage: dom.window.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
    dom.window.close();
  });
  const button = (label) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === label,
      ),
    label = (text) =>
      [...document.querySelectorAll("label")].find((l) =>
        l.textContent.trim().startsWith(text),
      );
  const click = async (el) => {
    assert.ok(el);
    assert.equal(el.disabled, false);
    assert.equal(Boolean(el.closest("fieldset[disabled]")), false);
    await act(() => el.click());
  };
  const fill = async (el, value) => {
    assert.ok(el);
    await act(() => {
      const proto =
        el.tagName === "TEXTAREA"
          ? dom.window.HTMLTextAreaElement.prototype
          : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  return {
    dom,
    root,
    button,
    label,
    click,
    fill,
    render: async (component, props = {}) =>
      act(() => root.render(createElement(component, props))),
  };
}
test("each calendar entry opens a temporary preview without asking for contact details or a password", async (t) => {
  const m = await mount(t),
    sent = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "/api/customer-calendar-onboarding");
    sent.push(JSON.parse(options.body));
    return Response.json({ url: "/join/calendar" });
  });
  for (const [index, kind, title] of [
    [1, "google_calendar", "Google Calendar"],
    [2, "ios_calendar", "iOS 日曆（iPhone／iPad）"],
    [3, "android_calendar", "Android 日曆"],
  ]) {
    window.history.replaceState({}, "", "/join");
    sessionStorage.clear();
    await m.render(ServiceJoin, {
      key: index,
      enabled: true,
      workflowEnabled: true,
      shareEmail: "reader@example.test",
      contactEmail: "operator@example.test",
    });
    await m.click(m.button("申請使用"));
    await m.fill(
      m.label("旅宿名稱").querySelector("input"),
      "Synthetic Preview",
    );
    await m.click(
      [...document.querySelectorAll("button[aria-pressed]")].find((b) =>
        b.textContent.startsWith("單房"),
      ),
    );
    await m.click(m.button("下一步：房間"));
    await m.fill(m.label("房號或房間名稱").querySelector("textarea"), "101");
    await m.click(m.button("下一步：目前的資料"));
    await m.click(m.button(title));
    assert.ok(
      !document.querySelector('input[type="email"],input[type="password"]'),
    );
    await m.click(m.button("下一步：連結或選檔預覽"));
    assert.equal(window.location.pathname, "/join/calendar");
    assert.equal(sent.at(-1).calendarKind, kind);
    assert.deepEqual(sent.at(-1).rooms, ["101"]);
  }
});
test("public upload previews without login; email return restores the exact preview and explicit save retries without duplicates", async (t) => {
  Object.assign(process.env, {
    CUSTOMER_WORKSPACES_ENABLED: "true",
    CUSTOMER_SESSION_SECRET: "synthetic-ui-secret-more-than-thirty-two",
    CUSTOMER_DEPLOYMENT_LINKS: "true",
    VERCEL_URL: "synthetic-ui.vercel.app",
  });
  const m = await mount(t),
    { store } = fixture();
  store.data.clear();
  const started = await startCalendarOnboarding(store, {
      name: "Synthetic UI Inn",
      kind: "rooms",
      rooms: ["101"],
      calendarKind: "ios_calendar",
    }),
    hash = draftHash(started.cookie),
    { args } = previewContext(store, hash, started.draft),
    proof = newLoginProof();
  let account,
    token,
    consumeCount = 0,
    loseReply = true;
  const commits = [];
  async function props() {
    const v = await calendarOnboardingView(store, hash, account);
    return {
      slug: "preview",
      property: v.property,
      initialKind: v.kind,
      initialStatus: v.status,
      configured: false,
      syncReady: false,
      connected: false,
      onboarding: v,
    };
  }
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("/upload?")) {
      const source = await uploadCalendar(
        ...args,
        Buffer.from(
          ics([event({ uid: "ui-public", title: "客人：Synthetic" })]),
        ),
        "synthetic.ics",
        { kind: "ios_calendar", ...range },
      );
      await updateCalendarDraft(store, hash, await draftForHash(store, hash), {
        sourceId: source.id,
      });
      return Response.json(source);
    }
    const input = JSON.parse(options.body);
    if (url === "/api/customer-login") {
      if (input.action === "prepare") return Response.json({ ok: true });
      if (input.action === "request") {
        await updateCalendarDraft(
          store,
          hash,
          await draftForHash(store, hash),
          { claimEmail: input.email, loginRequestId: input.requestKey },
        );
        await requestEmailLogin(
          store,
          { ...input, proof, draftHash: hash },
          async (_to, _subject, text) => {
            token = text.match(/\/signin#([^\s]+)/)[1];
            return "synthetic-mail";
          },
        );
        return Response.json({ detail: "登入連結已寄出" });
      }
      if (input.action === "consume") {
        consumeCount++;
        account = (
          await consumeEmailLogin(
            store,
            input.token,
            proof,
            hash,
            (await draftForHash(store, hash)).value.loginRequestId,
          )
        ).account;
        return Response.json({ url: "/join/calendar?verified=1" });
      }
    }
    if (input.action === "preview") {
      const p = await previewCalendar(...args, input.snapshotId, input.mapping);
      await updateCalendarDraft(store, hash, await draftForHash(store, hash), {
        previewId: p.id,
      });
      return Response.json(p);
    }
    if (input.action === "commit") {
      commits.push(input);
      if (!(await draftForHash(store, hash)).value.completed)
        await prepareCalendarSave(store, hash, input);
      if (!account || input.accountId !== account.id)
        return Response.json({ loginRequired: true, account: null });
      const result = await finishCalendarOnboarding(
        store,
        hash,
        account,
        input.accountId,
      );
      if (loseReply) {
        loseReply = false;
        throw Error("lost save response");
      }
      return Response.json({ completed: result });
    }
    throw Error(`Unexpected ${url} ${input.action}`);
  });
  await m.render(CalendarImport, await props());
  assert.ok(
    !document.querySelector('input[type="email"],input[type="password"]'),
  );
  const file = document.querySelector('input[type="file"]');
  Object.defineProperty(file, "files", {
    value: [new m.dom.window.File(["synthetic"], "synthetic.ics")],
    configurable: true,
  });
  await act(() =>
    file.dispatchEvent(new m.dom.window.Event("change", { bubbles: true })),
  );
  await m.click(m.button("上傳並讀取"));
  await m.click(m.label("101").querySelector("input"));
  await m.click(m.button("產生匯入預覽"));
  await m.click(m.label("我已核對房間").querySelector("input"));
  await m.click(m.label("這些日曆涵蓋本館").querySelector("input"));
  await m.click(m.button("確認預覽，保存 1 筆"));
  assert.equal(
    [...store.data.keys()].some((k) => k.startsWith("workspace:")),
    false,
  );
  assert.ok(document.querySelector('input[type="email"]'));
  assert.ok(!document.querySelector('input[type="password"]'));
  await m.fill(
    document.querySelector('input[type="email"]'),
    "owner@example.test",
  );
  await m.click(m.button("寄送登入連結"));
  assert.ok(token);
  window.history.pushState({}, "", `/signin#${token}`);
  await m.render(EmailSignIn);
  assert.equal(window.location.hash, "");
  assert.equal(consumeCount, 0);
  await m.click(m.button("確認登入並繼續"));
  assert.equal(consumeCount, 1);
  assert.equal(window.location.pathname, "/join/calendar");
  await m.render(CalendarImport, await props());
  assert.match(document.body.textContent, /保存已核對的 1 筆資料/);
  assert.equal(
    document.querySelector('input[type="file"]').closest("fieldset").disabled,
    true,
  );
  await m.click(m.button("以 owner@example.test 確認保存"));
  assert.ok(m.button("重試並確認相同操作"));
  await m.click(m.button("重試並確認相同操作"));
  assert.deepEqual(commits[2], commits[1]);
  assert.equal(
    (await store.read(`workspace:${started.draft.workspaceId}`)).value.bookings
      .length,
    1,
  );
  assert.equal(window.location.pathname, `/w/${started.draft.slug}/calendar`);
});
test("uncertain login mail freezes the email and reuses the same request key after prepare", async (t) => {
  const m = await mount(t),
    requests = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const input = JSON.parse(options.body);
    if (input.action === "prepare") return Response.json({ ok: true });
    requests.push(input);
    if (fail) {
      fail = false;
      throw Error("lost response");
    }
    return Response.json({ detail: "same mail confirmed" });
  });
  await m.render(PasswordlessLogin);
  await m.fill(
    document.querySelector('input[type="email"]'),
    "owner@example.test",
  );
  await m.click(m.button("寄送登入連結"));
  assert.equal(document.querySelector('input[type="email"]').disabled, true);
  await m.click(m.button("確認同一封登入信"));
  assert.deepEqual(requests[1], requests[0]);
  assert.match(document.body.textContent, /same mail confirmed/);
});
