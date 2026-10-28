// @vitest-environment node
import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { isSubmitEnter } from "./submit-on-enter";

function keydown(init: { key: string; shiftKey?: boolean; metaKey?: boolean; isComposing?: boolean; keyCode?: number }) {
  return {
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    metaKey: init.metaKey ?? false,
    keyCode: init.keyCode ?? 13,
    nativeEvent: { isComposing: init.isComposing ?? false, keyCode: init.keyCode ?? 13 },
  } as unknown as KeyboardEvent;
}

describe("isSubmitEnter", () => {
  it.each([
    ["Enter", keydown({ key: "Enter" }), true],
    ["Cmd+Enter", keydown({ key: "Enter", metaKey: true }), true],
    ["Shift+Enter", keydown({ key: "Enter", shiftKey: true }), false],
    ["Enter while composing", keydown({ key: "Enter", isComposing: true }), false],
    ["Enter with keyCode 229", keydown({ key: "Enter", keyCode: 229 }), false],
    ["another key", keydown({ key: "a" }), false],
  ])("%s", (_name, event, expected) => {
    expect(isSubmitEnter(event)).toBe(expected);
  });
});
