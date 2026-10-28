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
    const rule = declarations(".kb-doc mark.kb-annotated");
    expect(rule).toMatch(/background-image:\s*linear-gradient\(var\(--color-warning\),\s*var\(--color-warning\)\)/);
    expect(rule).toMatch(/box-decoration-break:\s*clone/);
    expect(rule).not.toMatch(/currentColor/);
  });

  it("underlines links in their own text color", () => {
    expect(declarations(".kb-doc .rich-text-editor a,\n.kb-doc .rich-text-editor a:hover")).toMatch(
      /text-decoration-color:\s*currentColor/,
    );
  });

  it("keeps a currentColor underline on a link holding an annotated sentence", () => {
    const rule = declarations(
      ".kb-doc .rich-text-editor a:has(mark.kb-annotated),\n.kb-doc .rich-text-editor a:has(mark.kb-annotated):hover",
    );
    expect(rule).toMatch(/text-decoration-line:\s*none/);
    expect(rule).toMatch(/background-image:\s*linear-gradient\(currentColor,\s*currentColor\)/);
  });

  it("alternates yellow and link-colored dashes where an annotation and a link overlap", () => {
    const rule = declarations(
      [
        ".kb-doc .rich-text-editor a mark.kb-annotated",
        '.kb-doc mark.kb-annotated a:not([href^="#kb-cite-"])',
        '.kb-doc mark.kb-annotated a:not([href^="#kb-cite-"]):hover',
      ].join(",\n"),
    );
    expect(rule).toMatch(/text-decoration-line:\s*none/);
    expect(rule).toMatch(
      /repeating-linear-gradient\(\s*to right,\s*var\(--color-warning\)[^,]*,\s*currentColor[^)]*\)/,
    );
  });
});
