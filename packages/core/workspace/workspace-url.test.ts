import { describe, expect, it } from "vitest";
import { workspaceUrlHost } from "./workspace-url";

describe("workspaceUrlHost", () => {
  it("returns the host of a full app URL", () => {
    expect(workspaceUrlHost("https://marvis.example.com")).toBe(
      "marvis.example.com",
    );
  });

  it("ignores scheme, path, and trailing slash", () => {
    expect(workspaceUrlHost("https://marvis.example.com/")).toBe(
      "marvis.example.com",
    );
    expect(workspaceUrlHost("http://marvis.example.com/app/onboarding")).toBe(
      "marvis.example.com",
    );
  });

  it("preserves a non-default port", () => {
    expect(workspaceUrlHost("https://my.host:3000")).toBe("my.host:3000");
  });

  it("accepts a bare host without a scheme", () => {
    expect(workspaceUrlHost("marvis.example.com")).toBe("marvis.example.com");
    expect(workspaceUrlHost("marvis.example.com/path")).toBe(
      "marvis.example.com",
    );
  });

  it("falls back to the brand host when no app URL is configured", () => {
    expect(workspaceUrlHost("")).toBe("marvis.ai");
    expect(workspaceUrlHost("   ")).toBe("marvis.ai");
    expect(workspaceUrlHost(null)).toBe("marvis.ai");
    expect(workspaceUrlHost(undefined)).toBe("marvis.ai");
  });
});
