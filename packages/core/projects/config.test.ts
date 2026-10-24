// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseProjectIcon } from "./config";

describe("parseProjectIcon", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["rocket", "rocket"],
    ["git-branch", "git-branch"],
    ["unicorn", null],
    ["🚀", null],
    ["icon:rocket", null],
  ])("parses %j", (input, expected) => {
    expect(parseProjectIcon(input)).toBe(expected);
  });
});
