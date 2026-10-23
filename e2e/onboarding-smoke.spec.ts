import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { waitForPageText } from "./helpers";

// Smoke test for onboarding: create a workspace on the standalone page, then
// connect a runtime. Each run uses a fresh email so the user always lands on
// /onboarding un-onboarded. Captures screenshots for review.

const SHOTS_DIR = "../shots-onboarding";

test.use({ viewport: { width: 1440, height: 900 } });

test("onboarding — create a workspace, then connect a runtime", async ({ page }) => {
  const api = new TestApiClient();
  await api.login(`onboarding-${Date.now()}@localhost`, "Onboarding Tester");

  await page.addInitScript((t) => localStorage.setItem("marvis_token", t), api.getToken());
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "Create a workspace");

  // 1. Create page — no welcome screen or questionnaire in front of it.
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByText("Tell us a bit about you.")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS_DIR}/01-create-workspace.png` });

  await page.getByLabel("Workspace name").fill(`Smoke ${Date.now()}`);
  await page.getByRole("button", { name: "Create workspace" }).click();

  // 2. Connect a runtime — web lays the CLI commands out inline and waits.
  await expect(page.getByRole("heading", { name: "Connect a runtime" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByText("Waiting for your computer to connect")).toBeVisible();
  await expect(page.getByText("marvis setup").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Start with Marvis" })).toBeDisabled();
  await page.screenshot({ path: `${SHOTS_DIR}/02-connect-runtime.png` });
});

// Leaving after creating the workspace (to install the CLI or the desktop app)
// must land back on the runtime step, or the workspace never gets its agent.
test("onboarding — resumes at the runtime step after leaving", async ({ page }) => {
  const api = new TestApiClient();
  const stamp = Date.now();
  await api.login(`resume-${stamp}@localhost`, "Resume Tester");
  await api.ensureWorkspace(`Resume ${stamp}`, `resume-${stamp}`);

  await page.addInitScript((t) => localStorage.setItem("marvis_token", t), api.getToken());
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("heading", { name: "Connect a runtime" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toHaveCount(0);
});

test("onboarding — zh-Hans renders Chinese labels", async ({ page, context, baseURL }) => {
  await context.addCookies([
    {
      name: "marvis-locale",
      value: "zh-Hans",
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
  const api = new TestApiClient();
  await api.login(`zh-${Date.now()}@localhost`, "中文用户");

  await page.addInitScript((t) => localStorage.setItem("marvis_token", t), api.getToken());
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "创建工作区");

  await expect(page.getByLabel("工作区名称")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `${SHOTS_DIR}/03-create-workspace-zh.png` });
});
