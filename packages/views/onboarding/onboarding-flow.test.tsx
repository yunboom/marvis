import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../locales/en/common.json";
import enOnboarding from "../locales/en/onboarding.json";
import enWorkspace from "../locales/en/workspace.json";

const TEST_RESOURCES = {
  en: { common: enCommon, onboarding: enOnboarding, workspace: enWorkspace },
};

const NEW_WORKSPACE = { id: "ws-new", slug: "new-ws", name: "New" };

const { workspaceList } = vi.hoisted(() => ({
  workspaceList: { workspaces: [] as unknown[], ready: true },
}));

vi.mock("@marvis/core/workspace", () => ({
  useWorkspaceList: () => workspaceList,
}));

vi.mock("../auth", () => ({ useLogout: () => vi.fn() }));

vi.mock("@marvis/core/auth", () => ({
  useAuthStore: Object.assign(
    (selector: (s: { user: unknown }) => unknown) =>
      selector({ user: { id: "u-1" } }),
    { getState: () => ({ user: { id: "u-1" } }) },
  ),
}));

vi.mock("@marvis/core/onboarding", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@marvis/core/onboarding",
  );
  return { ...actual, useBootstrapMika: () => ({ mutateAsync: vi.fn() }) };
});

vi.mock("../workspace/new-workspace-page", () => ({
  NewWorkspacePage: ({
    onCreated,
    onCancel,
    askAboutYou,
  }: {
    onCreated: (ws: unknown) => void;
    onCancel?: () => void;
    askAboutYou?: boolean;
  }) => (
    <div>
      {askAboutYou ? <p>asks about you</p> : null}
      <button type="button" onClick={() => onCreated(NEW_WORKSPACE)}>
        create workspace
      </button>
      {onCancel ? (
        <button type="button" onClick={onCancel}>
          cancel
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("./steps/step-connect-runtime", () => ({
  StepConnectRuntime: ({ wsSlug }: { wsSlug: string }) => (
    <p>runtime step for {wsSlug}</p>
  ),
}));

import { OnboardingFlow } from "./onboarding-flow";

beforeEach(() => {
  workspaceList.workspaces = [];
  workspaceList.ready = true;
});

function renderFlow(
  props: { onCancel?: () => void; firstRun?: boolean } = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <OnboardingFlow onComplete={vi.fn()} {...props} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("OnboardingFlow", () => {
  it("opens on the create-workspace page, then connects a runtime to it", () => {
    renderFlow();

    expect(screen.queryByText(/runtime step/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "create workspace" }));

    expect(screen.getByText("runtime step for new-ws")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "create workspace" }),
    ).not.toBeInTheDocument();
  });

  it("passes cancel through to the create page", () => {
    const onCancel = vi.fn();
    renderFlow({ onCancel });

    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    expect(onCancel).toHaveBeenCalledOnce();
  });

  // A member who leaves after creating the workspace (to install the CLI or
  // the desktop app) must land back on the runtime step, or Mika is never set
  // up for that workspace.
  it("resumes at the runtime step for a workspace from an unfinished pass", () => {
    workspaceList.workspaces = [{ id: "ws-old", slug: "old-ws", name: "Old" }];
    renderFlow({ firstRun: true });

    expect(screen.getByText("runtime step for old-ws")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "create workspace" }),
    ).not.toBeInTheDocument();
  });

  it("waits for the workspace list before choosing a step when resuming", () => {
    workspaceList.ready = false;
    renderFlow({ firstRun: true });

    expect(
      screen.queryByRole("button", { name: "create workspace" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime step/)).not.toBeInTheDocument();
  });

  it("never resumes when creating an additional workspace", () => {
    workspaceList.workspaces = [{ id: "ws-old", slug: "old-ws", name: "Old" }];
    renderFlow();

    expect(
      screen.getByRole("button", { name: "create workspace" }),
    ).toBeInTheDocument();
  });

  // Role and use case are per member, so only first-run onboarding asks.
  it("asks about the member only during first-run onboarding", () => {
    const { unmount } = renderFlow({ firstRun: true });
    expect(screen.getByText("asks about you")).toBeInTheDocument();
    unmount();

    renderFlow();
    expect(screen.queryByText("asks about you")).not.toBeInTheDocument();
  });

  it("offers no way back once the workspace exists", () => {
    renderFlow({ onCancel: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: "create workspace" }));

    expect(screen.queryByRole("button", { name: "cancel" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
  });
});
