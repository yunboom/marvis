// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildOpenLinkUrl, parseOpenLinkPath } from "./open-link";

function parse(url: string): string | null {
  return parseOpenLinkPath(new URL(url));
}

describe("buildOpenLinkUrl", () => {
  it("把站内路径编码进 path 参数", () => {
    expect(buildOpenLinkUrl("/dev/issues/DEV-1")).toBe(
      "marvis://open?path=%2Fdev%2Fissues%2FDEV-1",
    );
  });

  it("路径里的查询串和片段一并编码", () => {
    expect(buildOpenLinkUrl("/dev/issues/DEV-1?tab=activity#comment-c1")).toBe(
      "marvis://open?path=%2Fdev%2Fissues%2FDEV-1%3Ftab%3Dactivity%23comment-c1",
    );
  });
});

describe("parseOpenLinkPath", () => {
  it("解出站内路径", () => {
    expect(parse("marvis://open?path=%2Fdev%2Fissues%2FDEV-1")).toBe(
      "/dev/issues/DEV-1",
    );
  });

  it("与 buildOpenLinkUrl 往返一致", () => {
    const path = "/dev/issues/DEV-1?tab=activity#comment-c1";

    expect(parse(buildOpenLinkUrl(path))).toBe(path);
  });

  it("接受带尾部斜杠的形式（Windows 命令行会补斜杠）", () => {
    expect(parse("marvis://open/?path=%2Fdev%2Fissues%2FDEV-1")).toBe(
      "/dev/issues/DEV-1",
    );
  });

  it("保留链接末尾的片段（评论链接 #comment-xxx）", () => {
    expect(
      parse("marvis://open?path=%2Fdev%2Fissues%2FDEV-1#comment-c1"),
    ).toBe("/dev/issues/DEV-1#comment-c1");
  });

  it("根路径是合法的站内路径", () => {
    expect(parse("marvis://open?path=%2F")).toBe("/");
  });

  it.each([
    ["缺少 path 参数", "marvis://open"],
    ["path 为空", "marvis://open?path="],
    ["不以斜杠开头", "marvis://open?path=dev%2Fissues"],
    ["协议相对地址", "marvis://open?path=%2F%2Fevil.com%2Fx"],
    ["绝对 URL", "marvis://open?path=https%3A%2F%2Fevil.com%2Fx"],
    ["其他协议", "marvis://open?path=javascript%3Aalert(1)"],
    ["反斜杠开头", "marvis://open?path=%2F%5Cevil.com"],
    ["路径中间含反斜杠", "marvis://open?path=%2Fdev%5Cissues"],
    ["含制表符", "marvis://open?path=%2F%09%2Fevil.com"],
    ["含换行", "marvis://open?path=%2Fdev%0A%2Fevil.com"],
    ["登录页（会触发登出）", "marvis://open?path=%2Flogin"],
    ["带查询串的登录页", "marvis://open?path=%2Flogin%3Fnext%3D%2Fx"],
    ["超长路径", `marvis://open?path=%2F${"a".repeat(2_100)}`],
    ["不是 open 主机", "marvis://invite?path=%2Fdev"],
  ])("忽略%s", (_name, url) => {
    expect(parse(url)).toBeNull();
  });

  it("多个 path 参数时只取第一个", () => {
    expect(parse("marvis://open?path=%2Fa&path=%2Fb")).toBe("/a");
  });
});
