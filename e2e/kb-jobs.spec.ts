import "./env";

import { expect, test } from "@playwright/test";
import pg from "pg";
import { createTestApi } from "./helpers";

// A knowledge base job end to end: the member starts it in the browser, the
// agent's side (draft linked to the job, a page written into it) is played
// through the API so no agent CLI runs, and the member submits the draft
// from the job page. Edge cases of the right side live in the views tests;
// the server contract in the Go handler tests.
test("start a knowledge base job, watch its draft arrive and submit it", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await createTestApi();
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  const stamp = Date.now().toString(36);
  const slug = `jobs-${stamp}`;
  const agentName = `KB Job Agent ${stamp}`;
  let runtimeId: string | undefined;
  let agentId: string | undefined;
  let baseId: string | undefined;
  try {
    const workspace = (await api.getWorkspaces())[0]!;
    const user = await db.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [api.getEmail()]);
    const userId = user.rows[0]!.id;
    runtimeId = await api.seedRuntime(`KB job runtime ${stamp}`);
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agent (workspace_id, name, description, instructions, runtime_mode, runtime_config, runtime_id, visibility, permission_mode, max_concurrent_tasks, owner_id)
       VALUES ($1, $2, '', '', 'local', '{}'::jsonb, $3, 'private', 'private', 1, $4) RETURNING id`,
      [workspace.id, agentName, runtimeId, userId],
    );
    agentId = agent.rows[0]!.id;
    const base = await api.requestJSON<{ id: string }>("POST", "/api/kb/bases", {
      name: `Jobs KB ${stamp}`,
      slug,
      description: "",
      purpose: "",
      schema_mode: "default",
    });
    baseId = base.id;

    await page.addInitScript((token) => {
      localStorage.setItem("marvis_token", token!);
      localStorage.setItem("marvis:chat:isOpen", "false");
    }, api.getToken());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${workspace.slug}/kb/${slug}/jobs/new`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText(`What should happen in Jobs KB ${stamp}?`)).toBeVisible({ timeout: 45_000 });

    // Pick this test's agent (the workspace may hold others), then describe the job.
    const picked = page.getByRole("button", { name: agentName, exact: true });
    if (!(await picked.isVisible())) {
      await page.getByText("Agent", { exact: true }).locator("xpath=following-sibling::button[1]").click();
      await page.getByRole("textbox", { name: "Filter options" }).fill(agentName);
      await page.getByText(agentName, { exact: true }).last().click();
    }
    await expect(picked).toBeVisible();
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.click();
    await page.keyboard.type("Write the on-call page for payment callbacks.");
    await page.keyboard.press("Enter");

    await page.waitForURL(new RegExp(`/kb/${slug}/jobs/[0-9a-f-]{36}$`), { timeout: 30_000 });
    const jobId = page.url().split("/").pop()!;
    const draftSide = page.getByRole("region", { name: "Draft changes" });
    await expect(draftSide.getByText("No draft yet")).toBeVisible();
    await expect(draftSide.getByRole("button", { name: "Submit for review" })).toBeDisabled();
    await expect(page.getByText("Write the on-call page for payment callbacks.")).toBeVisible();

    // The agent's side: link a draft to the job and write a page into it.
    const draft = await api.requestJSON<{ id: string }>("POST", "/api/kb/drafts", { knowledge_base: slug, job_id: jobId });
    await api.requestJSON("POST", `/api/kb/drafts/${draft.id}/pages`, {
      parent: `${slug}:/`,
      slug: "on-call",
      frontmatter: { type: "Workflow", title: "On-call", description: "Who handles payment callbacks." },
      content: "# On-call\n\nThe payments on-call engineer handles callbacks.",
    });
    // kb.job.updated and kb.draft.updated bring the draft in without a reload;
    // submitting still waits for the turn.
    await expect(draftSide.getByText("On-call", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(draftSide.getByText("The payments on-call engineer handles callbacks.")).toBeVisible();
    await expect(draftSide.getByRole("button", { name: "Submit for review" })).toBeDisabled();

    // The turn ends; no daemon runs in this test, so the browser rereads it.
    await db.query(`UPDATE agent_task_queue SET status = 'completed', completed_at = now() WHERE agent_id = $1 AND status <> 'completed'`, [agentId]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(draftSide.getByText("On-call", { exact: true })).toBeVisible({ timeout: 30_000 });
    const submit = draftSide.getByRole("button", { name: "Submit for review" });
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(draftSide.getByText(/You submitted change request #\d+/)).toBeVisible({ timeout: 30_000 });
    await expect(draftSide.getByText("In review", { exact: true })).toBeVisible();
    const status = await db.query<{ status: string }>(`SELECT status FROM kb_merge_request WHERE draft_id = $1`, [draft.id]);
    expect(status.rows[0]?.status).toBe("open");
  } finally {
    if (baseId) {
      await db.query(`DELETE FROM kb_merge_request WHERE knowledge_base_id = $1`, [baseId]);
      await db.query(`DELETE FROM kb_job_draft WHERE job_id IN (SELECT id FROM kb_job WHERE knowledge_base_id = $1)`, [baseId]);
      await db.query(`DELETE FROM chat_session WHERE id IN (SELECT chat_session_id FROM kb_job WHERE knowledge_base_id = $1)`, [baseId]);
      await db.query(`DELETE FROM kb_job WHERE knowledge_base_id = $1`, [baseId]);
      await db.query(`DELETE FROM kb_draft_page WHERE draft_id IN (SELECT id FROM kb_draft WHERE knowledge_base_id = $1)`, [baseId]);
      await db.query(`DELETE FROM kb_draft WHERE knowledge_base_id = $1`, [baseId]);
      await db.query(`DELETE FROM kb_config_revision WHERE knowledge_base_id = $1`, [baseId]);
      await db.query(`DELETE FROM kb_base WHERE id = $1`, [baseId]);
    }
    if (agentId) {
      await db.query(`DELETE FROM agent_task_queue WHERE agent_id = $1`, [agentId]);
      await db.query(`DELETE FROM agent WHERE id = $1`, [agentId]);
    }
    if (runtimeId) await db.query(`DELETE FROM agent_runtime WHERE id = $1`, [runtimeId]);
    await db.end();
    await api.cleanup();
  }
});
