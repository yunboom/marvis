import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import type { Autopilot } from "@marvis/core/types";
import { renderWithI18n } from "../../test/i18n";
import { AutopilotBatchToolbar } from "./autopilot-list-actions";

vi.mock("@marvis/core/autopilots", () => ({
  useDeleteAutopilot: () => ({ mutateAsync: vi.fn() }),
  useUpdateAutopilot: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@marvis/core/paths", () => ({ useWorkspacePaths: () => ({ autopilotDetail: (id: string) => `/ws/autopilots/${id}` }) }));
vi.mock("../../navigation", () => ({ useIntentNavigate: () => vi.fn() }));

function row(id: string, systemKey: string | null = null): Autopilot {
  return { id, title: id, status: "active", system_key: systemKey } as unknown as Autopilot;
}

describe("AutopilotBatchToolbar", () => {
  it("offers delete for user autopilots in the selection", () => {
    renderWithI18n(<AutopilotBatchToolbar rows={[row("digest", "knowledge-digest"), row("deploy")]} onClear={() => {}} />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("hides delete when only built-in autopilots are selected", () => {
    renderWithI18n(<AutopilotBatchToolbar rows={[row("digest", "knowledge-digest")]} onClear={() => {}} />);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
  });
});
