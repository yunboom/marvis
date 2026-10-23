// @vitest-environment jsdom

import { cleanup, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkingAgentSummary } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";

vi.mock("@marvis/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => `Agent ${id}`,
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

// The real hover card renders its body only while open. Render it inline so the
// chip's own wiring to the hover body is observable: the MUL-5525 follow-up bug
// was in that wiring (`agents ?? []`), not in the body's rendering.
vi.mock("@marvis/ui/components/ui/hover-card", () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ render }: { render: React.ReactElement }) => render,
  HoverCardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="hover-content">{children}</div>
  ),
}));

import {
  WorkingAgentsHoverContent,
  WorkspaceAgentWorkingChip,
  chipActivity,
  chipAppearance,
} from "./workspace-agent-working-chip";

function makeAgent(id: string, runningTaskCount = 1): WorkingAgentSummary {
  return { id, running_task_count: runningTaskCount };
}

const UNKNOWN_HOVER = "Agents working: not loaded yet";
const EMPTY_HOVER = "No agents working right now";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceAgentWorkingChip", () => {
  it("counts exactly the agents the surface projection supplies", () => {
    renderWithI18n(
      <WorkspaceAgentWorkingChip
        value={false}
        onToggle={() => {}}
        agents={[makeAgent("agent-1"), makeAgent("agent-2", 3), makeAgent("agent-3")]}
      />,
    );

    const button = screen.getByRole("button", { name: "3 agents working" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    // Running agents breathe; the dot carries the activity cue.
    expect(
      screen.getByTestId("agent-working-dot").querySelector(".animate-breathe"),
    ).toBeTruthy();
  });

  // The whole point of MUL-5525: the chip must not invent a count of its own.
  // A surface whose filters leave no working rows has to read zero even while
  // other agents are busy elsewhere in the workspace.
  it("shows a known zero for a surface with no working rows", () => {
    renderWithI18n(
      <WorkspaceAgentWorkingChip value={false} onToggle={() => {}} agents={[]} />,
    );

    expect(
      screen.getByRole("button", { name: "0 agents working" }),
    ).toBeTruthy();
    expect(
      screen.getByTestId("agent-working-dot").querySelector(".animate-breathe"),
    ).toBeNull();
    expect(screen.getByText(EMPTY_HOVER)).toBeTruthy();
  });

  it("renders an indeterminate label while the projection is unresolved", () => {
    renderWithI18n(
      <WorkspaceAgentWorkingChip
        value={false}
        onToggle={() => {}}
        agents={undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Agents working: —" }),
    ).toBeTruthy();
    // No dot: neither "running" nor "idle" is known yet.
    expect(screen.queryByTestId("agent-working-dot")).toBeNull();
  });

  // Regression: the chip passed `agents ?? []` to the hover body, so an
  // unresolved projection rendered "No agents working right now" — an assertion
  // of zero on no evidence, from the one surface with room to say otherwise.
  it("does not let the hover body downgrade an unresolved projection to zero", () => {
    renderWithI18n(
      <WorkspaceAgentWorkingChip
        value={false}
        onToggle={() => {}}
        agents={undefined}
      />,
    );

    expect(screen.getByTestId("hover-content").textContent).toBe(UNKNOWN_HOVER);
    expect(screen.queryByText(EMPTY_HOVER)).toBeNull();
  });

  it("keeps the active filter visually selected after the final agent stops", () => {
    renderWithI18n(
      <WorkspaceAgentWorkingChip value onToggle={() => {}} agents={[]} />,
    );

    const button = screen.getByRole("button", { name: "0 agents working" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("bg-surface-selected");
  });
});

describe("WorkingAgentsHoverContent", () => {
  it("says the answer is not loaded yet when the projection is unresolved", () => {
    renderWithI18n(<WorkingAgentsHoverContent agents={undefined} />);

    expect(screen.getByText(UNKNOWN_HOVER)).toBeTruthy();
    expect(screen.queryByText(EMPTY_HOVER)).toBeNull();
  });

  it("says nobody is working only for a resolved empty projection", () => {
    renderWithI18n(<WorkingAgentsHoverContent agents={[]} />);

    expect(screen.getByText(EMPTY_HOVER)).toBeTruthy();
    expect(screen.queryByText(UNKNOWN_HOVER)).toBeNull();
  });

  it("lists the roster with each agent's active run count", () => {
    renderWithI18n(
      <WorkingAgentsHoverContent
        agents={[makeAgent("a1"), makeAgent("a2", 3)]}
      />,
    );

    expect(screen.getByText("2 active agents")).toBeTruthy();
    expect(screen.getByText("Agent a1")).toBeTruthy();
    expect(screen.getByText("1 run")).toBeTruthy();
    expect(screen.getByText("Agent a2")).toBeTruthy();
    expect(screen.getByText("3 runs")).toBeTruthy();
    expect(screen.queryByText(UNKNOWN_HOVER)).toBeNull();
    expect(screen.queryByText(EMPTY_HOVER)).toBeNull();
  });
});

describe("chipActivity", () => {
  it("keeps unresolved, resolved-empty and non-empty strictly apart", () => {
    expect(chipActivity(undefined)).toBe("unknown");
    expect(chipActivity([])).toBe("none");
    expect(chipActivity([makeAgent("a1")])).toBe("some");
  });
});

describe("chipAppearance", () => {
  it("wears a selected fill with foreground text while the filter is on", () => {
    const className = chipAppearance(true);
    expect(className).toContain("bg-surface-selected");
    expect(className).toContain("text-foreground");
    expect(className).not.toContain("text-muted-foreground");
  });

  it("stays muted while the filter is off", () => {
    expect(chipAppearance(false)).toContain("text-muted-foreground");
  });
});
