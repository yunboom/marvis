// @vitest-environment node
import { describe, expect, it } from "vitest";

import { normalizeBasePath } from "./base-path";

describe("normalizeBasePath", () => {
  it("is empty when unset or blank, serving the app at the root", () => {
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath(" / ")).toBe("");
  });

  it("yields one leading slash and no trailing slash", () => {
    expect(normalizeBasePath("marvis")).toBe("/marvis");
    expect(normalizeBasePath("/marvis/")).toBe("/marvis");
    expect(normalizeBasePath("//apps/marvis//")).toBe("/apps/marvis");
  });
});
