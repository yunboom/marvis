import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@marvis/core/api";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enWorkspace from "../locales/en/workspace.json";

const TEST_RESOURCES = { en: { common: enCommon, workspace: enWorkspace } };

const { mockMutate, mockLogout, mockSaveQuestionnaire, config } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockLogout: vi.fn(),
  mockSaveQuestionnaire: vi.fn(),
  config: { workspaceCreationDisabled: false, daemonAppUrl: "" },
}));

vi.mock("@marvis/core/onboarding", () => ({
  saveQuestionnaire: (...args: unknown[]) => mockSaveQuestionnaire(...args),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("../auth", () => ({ useLogout: () => mockLogout }));

vi.mock("@marvis/core/config", () => ({
  useConfigStore: (selector: (s: typeof config) => unknown) => selector(config),
}));

vi.mock("@marvis/core/workspace/mutations", () => ({
  useCreateWorkspace: () => ({ mutate: mockMutate, isPending: false }),
}));

import { NewWorkspacePage } from "./new-workspace-page";

function renderPage(props: { onCancel?: () => void; askAboutYou?: boolean } = {}) {
  const onCreated = vi.fn();
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <NewWorkspacePage onCreated={onCreated} {...props} />
    </I18nProvider>,
  );
  return { onCreated };
}

beforeEach(() => {
  mockMutate.mockReset();
  mockLogout.mockReset();
  mockSaveQuestionnaire.mockReset().mockResolvedValue(undefined);
  config.workspaceCreationDisabled = false;
});

function fillName() {
  fireEvent.change(screen.getByLabelText("Workspace name"), {
    target: { value: "Acme Inc" },
  });
}

describe("NewWorkspacePage — about you", () => {
  it("starts from engineer shipping code and saves it with the workspace", () => {
    renderPage({ askAboutYou: true });

    expect(screen.getByText("Engineer / developer")).toBeInTheDocument();
    expect(screen.getByText("Ship code with AI agents")).toBeInTheDocument();

    fillName();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(mockSaveQuestionnaire).toHaveBeenCalledWith({
      role: "engineer",
      role_skipped: false,
      use_case: ["ship_code"],
      use_case_skipped: false,
      version: 2,
    });
    expect(mockMutate).toHaveBeenCalledOnce();
  });

  it("applies dialog edits on Done", () => {
    renderPage({ askAboutYou: true });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("radio", { name: "Product manager" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Manage tasks for my team" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.getByText("Product manager")).toBeInTheDocument();
    expect(screen.getByText(/^Ship code with AI agents \+1$/)).toBeInTheDocument();

    fillName();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(mockSaveQuestionnaire).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "product",
        use_case: ["ship_code", "manage_team"],
      }),
    );
  });

  it("discards dialog edits on Cancel", () => {
    renderPage({ askAboutYou: true });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("radio", { name: "Designer" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Engineer / developer")).toBeInTheDocument();
    expect(screen.queryByText("Designer")).not.toBeInTheDocument();
  });

  it("does not ask when creating an additional workspace", () => {
    renderPage();

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fillName();
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(mockSaveQuestionnaire).not.toHaveBeenCalled();
  });
});

describe("NewWorkspacePage", () => {
  it("derives the URL and issue prefix from the name and creates with them", () => {
    const { onCreated } = renderPage();

    expect(
      screen.getByRole("heading", { level: 1, name: "Create a workspace" }),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Acme Inc" },
    });

    expect(screen.getByLabelText("URL")).toHaveValue("acme-inc");
    expect(screen.getByLabelText("Issue prefix")).toHaveValue("ACME");

    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(mockMutate).toHaveBeenCalledWith(
      { name: "Acme Inc", slug: "acme-inc", issue_prefix: "ACME" },
      expect.any(Object),
    );

    const ws = { id: "ws-1", slug: "acme-inc" };
    mockMutate.mock.calls[0]![1].onSuccess(ws);
    expect(onCreated).toHaveBeenCalledWith(ws);
  });

  it("keeps Create disabled until there is a name", () => {
    renderPage();

    expect(screen.getByRole("button", { name: "Create workspace" })).toBeDisabled();
  });

  it("shows a taken URL inline", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Workspace name"), {
      target: { value: "Acme" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));

    act(() => {
      mockMutate.mock.calls[0]![1].onError(
        new ApiError("conflict", 409, "Conflict", { code: "workspace_slug_conflict" }),
      );
    });

    expect(
      screen.getByText("That workspace URL is already taken."),
    ).toBeInTheDocument();
  });

  it("offers Cancel when there is a workspace to return to", () => {
    const onCancel = vi.fn();
    renderPage({ onCancel });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Log out" })).not.toBeInTheDocument();
  });

  it("offers Log out instead when there is nowhere to return to", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(mockLogout).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("replaces the form with a notice when the instance disables creation", () => {
    config.workspaceCreationDisabled = true;
    renderPage();

    expect(screen.getByText("Can't create a workspace")).toBeInTheDocument();
    expect(screen.queryByLabelText("Workspace name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});
