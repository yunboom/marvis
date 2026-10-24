// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseProjectIcon, projectGlyphIcon } from "./config";

describe("parseProjectIcon", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["icon:rocket", { kind: "glyph", glyph: "rocket" }],
    ["icon:not_a_glyph", null],
    ["🚀", { kind: "emoji", emoji: "🚀" }],
    [" 🚀 ", { kind: "emoji", emoji: "🚀" }],
  ])("parses %j", (input, expected) => {
    expect(parseProjectIcon(input)).toEqual(expected);
  });

  it("round-trips glyph values", () => {
    expect(parseProjectIcon(projectGlyphIcon("git_branch"))).toEqual({ kind: "glyph", glyph: "git_branch" });
  });
});
