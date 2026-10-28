// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./kb.css", import.meta.url), "utf8");

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = css.match(new RegExp(`(?:^|[}/])\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
}

describe("kb.css underlines", () => {
  it("underlines annotated sentences in the warning yellow", () => {
    expect(declarations(".kb-doc mark.kb-annotated")).toMatch(/text-decoration-color:\s*var\(--color-warning\)/);
  });

  it("underlines links in their own text color", () => {
    expect(declarations(".kb-doc .rich-text-editor a,\n.kb-doc .rich-text-editor a:hover")).toMatch(
      /text-decoration-color:\s*currentColor/,
    );
  });

  it("leaves only the annotation's underline on annotated link text", () => {
    expect(
      declarations(".kb-doc mark.kb-annotated a,\n.kb-doc .rich-text-editor a:has(mark.kb-annotated)"),
    ).toMatch(/text-decoration-line:\s*none/);
  });
});
