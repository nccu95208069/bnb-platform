import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import { CustomerCalendar } from "../src/components/customer-workspaces/calendar.tsx";

const property = {
  id: "property",
  name: "Synthetic inn",
  kind: "mixed",
  rooms: [
    { id: "101", name: "101" },
    { id: "102", name: "102" },
  ],
  villaRoomIds: ["101", "102"],
  sourceMode: "native",
};
const initial = {
  id: "workspace",
  slug: "synthetic-inn",
  name: property.name,
  version: 1,
  role: "owner",
  properties: [property],
  bookings: [],
};
const occupied = {
  ...initial,
  version: 2,
  bookings: [
    {
      id: "existing",
      propertyId: property.id,
      checkIn: "2026-10-05",
      checkOut: "2026-10-06",
      roomIds: ["101"],
      status: "confirmed",
    },
  ],
};

test("selected rooms remain removable when dates or refreshed availability introduce a conflict", async (t) => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://calendar.test",
  });
  const originalWindow = globalThis.window,
    originalDocument = globalThis.document,
    originalEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const { createRoot } = await import("react-dom/client");
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.IS_REACT_ACT_ENVIRONMENT = originalEnvironment;
    dom.window.close();
  });

  for (const trigger of ["date change", "availability refresh"]) {
    await t.test(trigger, async (t) => {
      const requests = [];
      t.mock.method(globalThis, "fetch", async (url, options = {}) => {
        if (options.method === "POST") {
          const payload = JSON.parse(options.body);
          requests.push(payload);
          return Response.json({
            bookingId: "created",
            workspace: {
              ...occupied,
              version: 3,
              bookings: [
                ...occupied.bookings,
                {
                  ...payload,
                  id: "created",
                  status: "confirmed",
                  payments: [],
                  guestNotified: false,
                },
              ],
            },
          });
        }
        return Response.json(occupied);
      });
      const root = createRoot(document.getElementById("root"));
      t.after(async () => {
        await act(() => root.unmount());
      });
      await act(() =>
        root.render(
          createElement(CustomerCalendar, {
            initial: trigger === "date change" ? occupied : initial,
          }),
        ),
      );
      const button = (label) =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent.trim() === label,
        );
      const room = (name) =>
        [...document.querySelectorAll("dialog button[aria-pressed]")].find(
          (b) => b.textContent.startsWith(name),
        );
      const click = async (element) => {
        assert.ok(element, "button exists");
        assert.equal(element.disabled, false, "button is usable");
        await act(() => element.click());
      };
      const date = async (value) => {
        const input = document.querySelector('dialog input[type="date"]');
        await act(() => {
          Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            "value",
          ).set.call(input, value);
          input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
          input.dispatchEvent(
            new dom.window.Event("change", { bubbles: true }),
          );
        });
      };
      await click(button("＋新增訂房"));
      await date(trigger === "date change" ? "2026-10-04" : "2026-10-05");
      await click(room("101"));
      assert.equal(room("101").getAttribute("aria-pressed"), "true");
      if (trigger === "date change") await date("2026-10-05");
      else await click(button("更新房況"));
      assert.match(room("101").textContent, /已售/);
      assert.equal(
        button("建立訂房").disabled,
        true,
        "conflicting selection cannot submit",
      );
      await click(room("102"));
      assert.equal(
        button("建立訂房").disabled,
        true,
        "adding a free room does not bypass conflict",
      );
      await click(room("101"));
      assert.equal(room("101").getAttribute("aria-pressed"), "false");
      assert.equal(
        room("101").disabled,
        true,
        "unselected occupied room cannot be re-added",
      );
      assert.equal(
        button("整棟 · 已有訂房").disabled,
        true,
        "villa inventory remains protected",
      );
      await click(button("建立訂房"));
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0].roomIds, ["102"]);
      assert.equal(requests[0].checkIn, "2026-10-05");
      assert.equal(requests[0].checkOut, "2026-10-06");
    });
  }
});
