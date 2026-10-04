import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
export async function mount(t, component, props = {}, hash = "") {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "https://operations.test/" + hash,
  });
  const original = {};
  for (const key of [
    "window",
    "document",
    "location",
    "history",
    "FormData",
    "IS_REACT_ACT_ENVIRONMENT",
  ])
    original[key] = globalThis[key];
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root"));
  t.after(async () => {
    await act(() => root.unmount());
    Object.assign(globalThis, original);
    dom.window.close();
  });
  await act(() => root.render(createElement(component, props)));
  const button = (label) =>
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent.trim() === label,
    );
  const control = (label, parent = document) =>
    [...parent.querySelectorAll("label")]
      .find(
        (l) =>
          [...l.childNodes]
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join("")
            .trim() === label,
      )
      ?.querySelector("input,textarea,select");
  const click = async (el) => {
    assert.ok(el, "control exists");
    assert.equal(el.disabled, false);
    await act(() => el.click());
  };
  const fill = async (el, value) => {
    assert.ok(el, "field exists");
    await act(() => {
      const proto =
        el.tagName === "SELECT"
          ? dom.window.HTMLSelectElement.prototype
          : el.tagName === "TEXTAREA"
            ? dom.window.HTMLTextAreaElement.prototype
            : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      el.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
  };
  return { dom, root, button, control, click, fill };
}
