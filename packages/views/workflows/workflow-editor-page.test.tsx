// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildIssueStatusCatalog } from "@marvis/core/issue-statuses";
import { agentListOptions, memberListOptions } from "@marvis/core/workspace/queries";
import { projectListOptions } from "@marvis/core/projects/queries";
import { renderWithI18n } from "../test/i18n";
import { WorkflowEditorPage } from "./workflow-editor-page";

const { createWorkflow } = vi.hoisted(() => ({ createWorkflow: vi.fn() }));

vi.mock("@marvis/core/api", () => ({ api: {}, ApiError: class extends Error {}, clientErrorMessage: () => null }));
vi.mock("@marvis/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@marvis/core/paths", () => ({ useCurrentWorkspace: () => ({ id: "ws-1", name: "Acme" }) }));
vi.mock("@marvis/core/issue-statuses/hooks", () => ({ useIssueStatuses: () => buildIssueStatusCatalog([]) }));
vi.mock("@marvis/core/workspace/hooks", () => ({ useActorName: () => ({ getActorName: () => "Builder" }) }));
vi.mock("@marvis/core/issue-workflows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@marvis/core/issue-workflows")>()),
  useIssueWorkflows: () => ({ workflows: [], isLoaded: true }),
  useCreateIssueWorkflow: () => ({ mutateAsync: createWorkflow, isPending: false }),
  useUpdateIssueWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteIssueWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid={`avatar-${actorId}`} />,
}));

function renderEditor(props: { template?: "content"; canCreateStatus?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(projectListOptions("ws-1").queryKey, [] as never);
  qc.setQueryData(agentListOptions("ws-1").queryKey, [{ id: "agent-1", name: "Builder", archived_at: null }] as never);
  qc.setQueryData(memberListOptions("ws-1").queryKey, [] as never);
  renderWithI18n(
    <QueryClientProvider client={qc}>
      <WorkflowEditorPage workflowId={null} seed={null} canEdit onBack={vi.fn()} onOpen={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  createWorkflow.mockReset();
});

describe("WorkflowEditorPage", () => {
  it("edits a new status step's handoff before the save (MUL-8118)", async () => {
    createWorkflow.mockResolvedValue({ id: "wf-1" });
    renderEditor();

    await addNewStatus("Deploy");

    // The new step is selected, and its handoff can be edited right away.
    expect(screen.getByRole("heading", { name: "Deploy" })).toBeTruthy();
    const agent = screen.getByRole("radio", { name: /Hand to an agent/ });
    expect((agent as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(agent);
    fireEvent.click(screen.getByRole("button", { name: "Choose an agent" }));
    fireEvent.click(await screen.findByText("Builder"));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Release" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const steps = createWorkflow.mock.calls[0]![0].steps as unknown[];
    expect(steps).toContainEqual({
      new_status: { name: "Deploy" },
      handler: { type: "agent", id: "agent-1" },
      instructions: "",
    });
  });

  it("saves the board group picked for a new status", async () => {
    createWorkflow.mockResolvedValue({ id: "wf-1" });
    renderEditor();
    await addNewStatus("Review");

    const group = screen.getByRole("radiogroup", { name: "Board group" });
    expect(within(group).getByRole("radio", { name: "Working" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: "Needs attention" }));

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Release" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createWorkflow).toHaveBeenCalled());
    const steps = createWorkflow.mock.calls[0]![0].steps as { new_status?: unknown }[];
    expect(steps.find((step) => step.new_status)?.new_status).toEqual({ name: "Review", status_group: "needs_attention" });
  });

  it("resolves a default next over the unsaved steps, as the save will", async () => {
    renderEditor();
    await addNewStatus("QA");
    await addNewStatus("Deploy");

    // QA is followed by Deploy on the board, so that is where its agent goes
    // next — not Done, the next status that exists before the save.
    fireEvent.click(stepCard("QA"));
    fireEvent.click(screen.getByRole("radio", { name: /Hand to an agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose an agent" }));
    fireEvent.click(await screen.findByText("Builder"));

    expect(screen.getByRole("combobox", { name: "When done, move to" }).textContent).toContain("Next column (Deploy)");
    expect(stepCard("QA").textContent).toContain("then → Deploy");
    // The explicit choices still list only statuses that exist before the save.
    fireEvent.click(screen.getByRole("combobox", { name: "When done, move to" }));
    expect(screen.queryByRole("option", { name: "Deploy" })).toBeNull();
  });
});

describe("WorkflowEditorPage step zones", () => {
  it("keeps blocked in its own zone, apart from the end steps", () => {
    renderEditor();

    const blocked = screen.getByRole("region", { name: "Blocked" });
    expect(within(blocked).getByRole("switch", { name: /Blocked/ })).toBeTruthy();
    const end = screen.getByRole("region", { name: "End" });
    expect(within(end).queryByRole("switch")).toBeNull();
    expect(within(end).getAllByRole("button", { name: /can't be removed/ })).toHaveLength(2);
  });

  it("creates a step straight from the search query", async () => {
    renderEditor();
    openAddStep();
    fireEvent.change(await screen.findByPlaceholderText("Search the status library"), { target: { value: "QA" } });
    fireEvent.click(screen.getByRole("button", { name: "New status “QA”" }));

    expect(screen.getByRole("heading", { name: "QA" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Status name")).toBeNull();
  });

  it("removes a middle step from its card", async () => {
    renderEditor();
    await addNewStatus("QA");

    fireEvent.click(screen.getByRole("button", { name: "Remove QA" }));
    expect(screen.queryByRole("heading", { name: "QA" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove QA" })).toBeNull();
  });
});

// Statuses are shared by every board, so only admins add them (MUL-8120).
describe("WorkflowEditorPage status creation", () => {
  it("blocks saving a template that needs new statuses for a member", () => {
    renderEditor({ template: "content", canCreateStatus: false });
    expect(screen.getByRole("alert").textContent).toMatch(/Only workspace admins can add statuses/);
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
  });

  it("lets an admin save the same template", () => {
    renderEditor({ template: "content", canCreateStatus: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
  });
});

/** A step in the list (the detail panel's status picker shares its name). */
function stepCard(name: string) {
  const card = screen
    .getAllByRole("button", { name: new RegExp(`^${name}`) })
    .find((b) => b.hasAttribute("aria-pressed"));
  if (!card) throw new Error(`no step card ${name}`);
  return card;
}

/** The add-step menu at the end of the middle steps. */
function openAddStep() {
  const buttons = screen.getAllByRole("button", { name: /Add step/ });
  fireEvent.click(buttons[buttons.length - 1]!);
}

async function addNewStatus(name: string) {
  openAddStep();
  fireEvent.click(await screen.findByRole("button", { name: /New status/ }));
  const input = screen.getByPlaceholderText("Status name");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}
