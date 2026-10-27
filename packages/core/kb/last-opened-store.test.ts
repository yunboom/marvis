import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeBase } from "../types";
import { pickEntryKnowledgeBase, useKbLastOpenedStore } from "./last-opened-store";

function makeBase(id: string, createdAt: string): KnowledgeBase {
  return {
    id,
    workspace_id: "ws-1",
    name: id,
    slug: id,
    description: "",
    schema_mode: "default",
    created_by: "",
    page_count: 0,
    content_version: 0,
    created_at: createdAt,
    updated_at: "",
    pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
  };
}

const NEWER = makeBase("kb-newer", "2026-10-20T00:00:00Z");
const OLDEST = makeBase("kb-oldest", "2026-09-01T00:00:00Z");
const UNDATED = makeBase("kb-undated", "");

describe("pickEntryKnowledgeBase", () => {
  it("opens the last opened knowledge base while it is listed", () => {
    expect(pickEntryKnowledgeBase([NEWER, OLDEST], "kb-newer")).toBe(NEWER);
  });

  it("falls back to the earliest created when nothing was opened or it is gone", () => {
    expect(pickEntryKnowledgeBase([NEWER, OLDEST], undefined)).toBe(OLDEST);
    expect(pickEntryKnowledgeBase([NEWER, OLDEST], "kb-deleted")).toBe(OLDEST);
  });

  it("ranks a base without a creation time last", () => {
    expect(pickEntryKnowledgeBase([UNDATED, NEWER], undefined)).toBe(NEWER);
  });

  it("returns nothing for a workspace without knowledge bases", () => {
    expect(pickEntryKnowledgeBase([], "kb-newer")).toBeUndefined();
  });
});

describe("useKbLastOpenedStore", () => {
  afterEach(() => useKbLastOpenedStore.setState({ byWorkspace: {} }));

  it("remembers the last opened knowledge base per workspace", () => {
    const { setLastOpened } = useKbLastOpenedStore.getState();
    setLastOpened("ws-1", "kb-a");
    setLastOpened("ws-2", "kb-b");
    setLastOpened("ws-1", "kb-c");

    expect(useKbLastOpenedStore.getState().byWorkspace).toEqual({ "ws-1": "kb-c", "ws-2": "kb-b" });
  });

  it("ignores an empty workspace or knowledge base id", () => {
    const { setLastOpened } = useKbLastOpenedStore.getState();
    setLastOpened("", "kb-a");
    setLastOpened("ws-1", "");

    expect(useKbLastOpenedStore.getState().byWorkspace).toEqual({});
  });
});
