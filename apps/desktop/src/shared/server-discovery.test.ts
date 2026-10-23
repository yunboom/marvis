// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_ADDRESS, normalizeServerAddress } from "./server-discovery";

describe("DEFAULT_SERVER_ADDRESS", () => {
  it("points at the mDNS host on the backend port", () => {
    expect(DEFAULT_SERVER_ADDRESS).toBe("http://marvis.local:13840");
  });
});

describe("normalizeServerAddress", () => {
  it.each([
    ["192.168.1.20:3000", "http://192.168.1.20:3000"],
    ["marvis.local:3000/", "http://marvis.local:3000"],
    ["http://marvis.local:3000/login?x=1", "http://marvis.local:3000"],
    ["https://m.example.com", "https://m.example.com"],
    ["  http://marvis.local:13840  ", "http://marvis.local:13840"],
    ["HTTP://Marvis.Local:13840", "http://marvis.local:13840"],
    ["http://user:pass@m.example.com:3000/x", "http://m.example.com:3000"],
    ["http://[::1]:13840/", "http://[::1]:13840"],
    ["localhost", "http://localhost"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeServerAddress(input)).toBe(expected);
  });

  it.each(["", "   ", "ftp://x", "http://", "file:///tmp/x", "javascript:alert(1)"])(
    "rejects %j",
    (input) => {
      expect(normalizeServerAddress(input)).toBeNull();
    },
  );
});
