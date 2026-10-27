// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { isPortalLayerShortcutTarget } from "./definitions";

describe("isPortalLayerShortcutTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  function mount(html: string) {
    document.body.innerHTML = html;
  }

  it("treats a keypress inside a dialog as the dialog's", () => {
    mount(`<div role="dialog"><button id="t"></button></div>`);
    expect(isPortalLayerShortcutTarget(document.getElementById("t"))).toBe(true);
  });

  it("leaves a page's own keypress to it", () => {
    mount(`<main><button id="t"></button></main>`);
    expect(isPortalLayerShortcutTarget(document.getElementById("t"))).toBe(false);
  });

  // A page hosted in a non-modal dialog (the message box) owns keys pressed in
  // that dialog, but not in a menu or dialog opened above it.
  it("lets the listener's own layer through, but not a layer inside it", () => {
    mount(`
      <div role="dialog" id="own">
        <button id="t"></button>
        <div role="listbox"><button id="m"></button></div>
      </div>
    `);
    const own = document.getElementById("own");
    expect(isPortalLayerShortcutTarget(document.getElementById("t"), own)).toBe(false);
    expect(isPortalLayerShortcutTarget(document.getElementById("m"), own)).toBe(true);
  });

  it("defers to a modal layer that has made the page inert", () => {
    mount(`
      <main><button id="t"></button></main>
      <div data-base-ui-inert></div>
    `);
    expect(isPortalLayerShortcutTarget(document.getElementById("t"))).toBe(true);
  });

  // The host dialog itself marks the page inert, so with `ownLayer` only
  // another open layer counts — a modal or menu portaled beside it.
  it("ignores the host dialog's own inert marker", () => {
    mount(`
      <div role="dialog" id="own"><button id="t"></button></div>
      <div data-base-ui-inert></div>
    `);
    const own = document.getElementById("own");
    expect(isPortalLayerShortcutTarget(document.getElementById("t"), own)).toBe(false);
    expect(isPortalLayerShortcutTarget(document.body, own)).toBe(false);
  });

  it("defers to another layer open beside the host dialog", () => {
    mount(`
      <div role="dialog" id="own"><button id="t"></button></div>
      <div role="menu"><button id="m"></button></div>
    `);
    const own = document.getElementById("own");
    expect(isPortalLayerShortcutTarget(document.getElementById("t"), own)).toBe(true);
  });

  // A closed `keepMounted` popover (the agent chip in the issue header) stays
  // in the DOM under a hidden positioner; it must not hold the host's Escape.
  it("ignores a closed keepMounted layer beside the host dialog", () => {
    mount(`
      <div role="dialog" id="own"><button id="t"></button></div>
      <div hidden><div role="dialog"></div></div>
    `);
    const own = document.getElementById("own");
    expect(isPortalLayerShortcutTarget(document.getElementById("t"), own)).toBe(false);
  });
});
