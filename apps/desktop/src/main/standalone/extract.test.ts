// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installArchive, systemTarPath } from "./extract";

let dir: string;
let archive: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marvis-extract-"));

  const src = join(dir, "src");
  await mkdir(join(src, "bin"), { recursive: true });
  await writeFile(join(src, "bin", "server"), "binary");
  await writeFile(join(src, "VERSION"), "1.2.3");

  archive = join(dir, "bundle.tar.xz");
  execFileSync("tar", ["-cJf", archive, "-C", src, "."]);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("systemTarPath", () => {
  it("uses the bundled bsdtar on Windows", () => {
    expect(systemTarPath("win32", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\tar.exe");
    expect(systemTarPath("win32", {})).toBe("tar");
    expect(systemTarPath("darwin", { SystemRoot: "C:\\Windows" })).toBe("tar");
  });
});

describe("installArchive", () => {
  it("extracts into finalDir and leaves no tmp dir", async () => {
    const finalDir = join(dir, "server");

    await installArchive(archive, finalDir);

    expect(await readFile(join(finalDir, "bin", "server"), "utf8")).toBe("binary");
    expect(await readFile(join(finalDir, "VERSION"), "utf8")).toBe("1.2.3");
    expect(existsSync(`${finalDir}.tmp`)).toBe(false);
  });

  it("replaces an existing finalDir and removes a stale tmp dir", async () => {
    const finalDir = join(dir, "server");
    await mkdir(finalDir);
    await writeFile(join(finalDir, "old.txt"), "old");
    await mkdir(`${finalDir}.tmp`);
    await writeFile(join(`${finalDir}.tmp`, "stale.txt"), "stale");

    await installArchive(archive, finalDir);

    expect(existsSync(join(finalDir, "old.txt"))).toBe(false);
    expect(existsSync(join(finalDir, "stale.txt"))).toBe(false);
    expect(await readFile(join(finalDir, "VERSION"), "utf8")).toBe("1.2.3");
    expect(existsSync(`${finalDir}.tmp`)).toBe(false);
  });

  it("leaves the previous finalDir untouched when extraction fails", async () => {
    const finalDir = join(dir, "server");
    await mkdir(finalDir);
    await writeFile(join(finalDir, "old.txt"), "old");
    const failing = async () => {
      throw new Error("tar failed");
    };

    await expect(installArchive(archive, finalDir, failing)).rejects.toThrow("tar failed");

    expect(await readFile(join(finalDir, "old.txt"), "utf8")).toBe("old");
    expect(existsSync(`${finalDir}.tmp`)).toBe(false);
  });
});
