// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_ADDRESS,
  isMdnsHostname,
  mdnsHostname,
  normalizeServerAddress,
  preferredIPv4,
  sanitizeDisplayText,
} from "./server-discovery";

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

describe("sanitizeDisplayText", () => {
  it.each([
    ["设计部 Marvis", "设计部 Marvis"],
    ["evil\u001b[31mred", "evil[31mred"],
    ["a\u0000b\u0007c\u0085d\u009be", "abcde"],
    ["line1\nline2\tx", "line1line2x"],
    ["abc\u202edcba\u2066x\u2069\u200f\u061c", "abcdcbax"],
    ["  name  ", "name"],
  ])("cleans %j", (input, expected) => {
    expect(sanitizeDisplayText(input)).toBe(expected);
  });
});

describe("mdnsHostname", () => {
  it.each([
    ["marvis.local.", "marvis.local"],
    ["Marvis-2.LOCAL", "marvis-2.local"],
    ["", null],
    ["evil host.local", null],
    ["evil/x.local", null],
    ["设计.local", null],
    [".local", null],
  ])("normalizes %j", (input, expected) => {
    expect(mdnsHostname(input)).toBe(expected);
  });
});

describe("isMdnsHostname", () => {
  it.each([
    ["marvis.local", true],
    ["MARVIS-2.Local.", true],
    ["192.168.1.20", false],
    ["api.example.com", false],
    ["local", false],
  ])("%j", (input, expected) => {
    expect(isMdnsHostname(input)).toBe(expected);
  });
});

describe("preferredIPv4", () => {
  it.each([
    [["fe80::1%en0", "203.0.113.5", "192.168.1.20"], "192.168.1.20"],
    [["10.0.0.5", "192.168.1.20"], "10.0.0.5"],
    [["172.16.4.2"], "172.16.4.2"],
    [["172.32.0.1", "fe80::1"], "172.32.0.1"],
    [["fe80::1", "::1"], null],
    [["not an ip", "1.2.3"], null],
    [[], null],
  ])("%j", (addresses, expected) => {
    expect(preferredIPv4(addresses)).toBe(expected);
  });
});
