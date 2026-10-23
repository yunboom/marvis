import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@marvis/core/api";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enWorkspace from "../locales/en/workspace.json";

const TEST_RESOURCES = { en: { common: enCommon, workspace: enWorkspace } };

const { mockMutate, mockLogout, config } = vi.hoisted(() => ({
  mockMutate: vi.fn(),
  mockLogout: vi.fn(),
  config: { workspaceCreationDisabled: false, daemonAppUrl: "" },
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

function renderPage(props: { onCancel?: () => void } = {}) {
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
  config.workspaceCreationDisabled = false;
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
