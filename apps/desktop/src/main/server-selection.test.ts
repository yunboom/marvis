// @vitest-environment node
import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, it } from "vitest";
import type { SelectedServer } from "../shared/server-discovery";
import { readSelectedServer, writeSelectedServer } from "./server-selection";

const selected: SelectedServer = {
  url: "http://marvis.local:13840",
  name: "设计部 Marvis",
  instanceId: "7f3a",
  source: "lan",
  appUrl: "http://marvis.local:3000",
};

describe("server selection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "marvis-desktop-server-"));
  });

  it("reads back what was written", async () => {
    await writeSelectedServer(dir, selected);

    expect(await readSelectedServer(dir)).toEqual(selected);
  });

  it("round-trips a manual server without a web app", async () => {
    const manual: SelectedServer = { ...selected, source: "manual", appUrl: "" };

    await writeSelectedServer(dir, manual);

    expect(await readSelectedServer(dir)).toEqual(manual);
  });

  it("writes exactly the keys the CLI reads", async () => {
    await writeSelectedServer(dir, selected);

    const raw = JSON.parse(await readFile(join(dir, "server.json"), "utf-8"));

    expect(raw).toEqual({
      url: "http://marvis.local:13840",
      name: "设计部 Marvis",
      instanceId: "7f3a",
      source: "lan",
      appUrl: "http://marvis.local:3000",
    });
  });

  it("creates the user data directory when it is missing", async () => {
    const nested = join(dir, "nested", "userData");

    await writeSelectedServer(nested, selected);

    expect(await readSelectedServer(nested)).toEqual(selected);
  });

  it("replaces a previous selection", async () => {
    await writeSelectedServer(dir, selected);
    const next: SelectedServer = { ...selected, url: "https://m.example.com", source: "manual" };

    await writeSelectedServer(dir, next);

    expect(await readSelectedServer(dir)).toEqual(next);
  });

  it("returns null when server.json does not exist", async () => {
    expect(await readSelectedServer(dir)).toBeNull();
  });

  it("returns null when server.json is corrupt", async () => {
    await writeFile(join(dir, "server.json"), "{");

    expect(await readSelectedServer(dir)).toBeNull();
  });

  it.each([
    ["not an object", "[]"],
    ["missing url", JSON.stringify({ ...selected, url: undefined })],
    ["non-http url", JSON.stringify({ ...selected, url: "ftp://x" })],
    ["unknown source", JSON.stringify({ ...selected, source: "mdns" })],
    ["non-string instanceId", JSON.stringify({ ...selected, instanceId: 7 })],
    ["non-string appUrl", JSON.stringify({ ...selected, appUrl: null })],
  ])("returns null when server.json has the wrong shape: %s", async (_label, body) => {
    await writeFile(join(dir, "server.json"), body);

    expect(await readSelectedServer(dir)).toBeNull();
  });

  it("strips control and bidi characters from the saved name", async () => {
    await writeFile(
      join(dir, "server.json"),
      JSON.stringify({ ...selected, name: "evil\u001b[31m\u202ename" }),
    );

    expect(await readSelectedServer(dir)).toMatchObject({ name: "evil[31mname" });
  });
});
