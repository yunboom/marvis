// @vitest-environment node
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createActivityLogger } from "./activity-log";

describe("createActivityLogger", () => {
  it("creates the log directory and appends lines in order", async () => {
    const root = await mkdtemp(join(tmpdir(), "standalone-activity-"));
    const file = join(root, "logs", "standalone.log");
    const at = new Date(Date.UTC(2026, 9, 28, 8, 0, 0));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const log = createActivityLogger(file, () => at);

    log("standalone install failed", { error: "manifest returned 404" });
    log("second");

    await vi.waitFor(async () => {
      expect(await readFile(file, "utf-8")).toBe(
        '2026-10-28T08:00:00.000Z standalone install failed {"error":"manifest returned 404"}\n' +
          "2026-10-28T08:00:00.000Z second\n",
      );
    });
  });
});
