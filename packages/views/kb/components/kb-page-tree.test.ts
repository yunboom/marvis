// @vitest-environment node
import { describe, expect, it } from "vitest";
import { expandTreeRows, isTreeRowOpen, toggleTreeRow, type TreeExpansion } from "./kb-page-tree";

const EMPTY: TreeExpansion = { expanded: new Set(), collapsed: new Set() };

describe("page tree expansion", () => {
  it("opens top-level rows by default and deeper rows only when expanded", () => {
    expect(isTreeRowOpen(EMPTY, "top", 0)).toBe(true);
    expect(isTreeRowOpen(EMPTY, "child", 1)).toBe(false);
  });

  it("keeps a top-level row the reader collapsed closed until reopened", () => {
    const collapsed = toggleTreeRow(EMPTY, "top", 0);
    expect(isTreeRowOpen(collapsed, "top", 0)).toBe(false);

    const reopened = toggleTreeRow(collapsed, "top", 0);
    expect(isTreeRowOpen(reopened, "top", 0)).toBe(true);
  });

  it("toggles deeper rows", () => {
    const open = toggleTreeRow(EMPTY, "child", 1);
    expect(isTreeRowOpen(open, "child", 1)).toBe(true);
    expect(isTreeRowOpen(toggleTreeRow(open, "child", 1), "child", 1)).toBe(false);
  });

  it("expands the ancestors of the page being read, even a collapsed top-level one", () => {
    const collapsed = toggleTreeRow(EMPTY, "top", 0);
    const next = expandTreeRows(collapsed, ["top", "child"]);
    expect(isTreeRowOpen(next, "top", 0)).toBe(true);
    expect(isTreeRowOpen(next, "child", 1)).toBe(true);
    expect(expandTreeRows(next, ["top", "child"])).toBe(next);
  });
});
