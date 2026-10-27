// @vitest-environment node
import { describe, expect, it } from "vitest";
import { instructionsPreview } from "./instructions-preview";

describe("instructionsPreview", () => {
  it.each([
    ["empty input", "", ""],
    ["null input", null, ""],
    ["whitespace only", "  \n\t ", ""],
    ["plain text", "Summarize the day", "Summarize the day"],
    ["collapses newlines", "Line one\n\nLine two", "Line one Line two"],
    ["headings", "## Goal\nShip it", "Goal Ship it"],
    ["bullet lists", "- one\n* two\n+ three", "one two three"],
    ["ordered lists", "1. first\n2) second", "first second"],
    ["blockquotes", "> quoted text", "quoted text"],
    ["bold and italic", "**bold** and _soft_ and *em*", "bold and soft and em"],
    ["strikethrough", "~~gone~~ kept", "gone kept"],
    ["inline code", "Run `npm audit` now", "Run npm audit now"],
    ["code fences", "```bash\nnpm test\n```", "npm test"],
    ["links keep their label", "See [docs](https://x.test)", "See docs"],
    ["images keep their alt", "![chart](https://x.test/a.png) done", "chart done"],
    ["html tags", "<b>Bold</b> text", "Bold text"],
    ["task checkboxes", "- [ ] todo\n- [x] done", "todo done"],
    ["mentions", "Ping [@Alice](mention://member/1)", "Ping @Alice"],
    ["issue mentions", "Fix [MUL-1](mention://issue/2)", "Fix MUL-1"],
    ["snake_case stays", "use snake_case_name", "use snake_case_name"],
  ])("%s", (_name, input, expected) => {
    expect(instructionsPreview(input)).toBe(expected);
  });
});
