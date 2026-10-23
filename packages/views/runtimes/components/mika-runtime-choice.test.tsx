import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@marvis/core/i18n/react";
import type { AgentRuntime } from "@marvis/core/types";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { MikaRuntimeChoice } from "./mika-runtime-choice";

vi.mock("@marvis/core/api", () => ({ api: { listRuntimeModels: vi.fn() } }));

const RESOURCES = {
  en: { agents: enAgents, common: enCommon, runtimes: enRuntimes },
};

const runtimes = [
  { id: "rt-1", name: "MacBook", provider: "claude", status: "online" },
  { id: "rt-2", name: "Server", provider: "codex", status: "offline" },
] as AgentRuntime[];

function renderChoice(props: Partial<Parameters<typeof MikaRuntimeChoice>[0]>) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider locale="en" resources={RESOURCES}>
        <MikaRuntimeChoice
          runtimes={runtimes}
          value={{ runtimeId: "rt-1", model: "" }}
          onChange={() => {}}
          layout="list"
          {...props}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("MikaRuntimeChoice list layout", () => {
  it("selects a runtime and clears the model chosen for the previous one", async () => {
    const onChange = vi.fn();
    renderChoice({ value: { runtimeId: "rt-1", model: "opus" }, onChange });

    await userEvent.click(screen.getByRole("button", { name: /Server/ }));

    // Models are per-runtime, so carrying one across would send a model the
    // new runtime may not have.
    expect(onChange).toHaveBeenCalledWith({ runtimeId: "rt-2", model: "" });
  });

  // The dropdown layout honoured `disabled`; the list layout dropped it, so a
  // member could switch machines while the connect request was in flight and
  // end up with Mika on a runtime they no longer had selected.
  it("stops the choice changing while a submit is in flight", async () => {
    const onChange = vi.fn();
    renderChoice({ disabled: true, onChange });

    const row = screen.getByRole("button", { name: /Server/ });
    expect(row).toBeDisabled();

    await userEvent.click(row);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("MikaRuntimeChoice grouped layout", () => {
  const grouped = [
    { id: "rt-1", name: "Claude (dev-box)", provider: "claude", status: "online", device_info: "dev-box · 2.1.309", daemon_id: "d1" },
    { id: "rt-2", name: "Codex (dev-box)", provider: "codex", status: "online", device_info: "dev-box · 0.149.1", daemon_id: "d1" },
    { id: "rt-3", name: "Codex (build)", provider: "codex", status: "offline", device_info: "build · 0.148.0", daemon_id: "d2" },
  ] as AgentRuntime[];

  it("heads each machine once and names rows without the host", () => {
    renderChoice({ layout: "grouped", runtimes: grouped });

    const groups = screen.getAllByRole("radiogroup");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["dev-box", "build"]);
    expect(screen.getByRole("radio", { name: /Claude.*2\.1\.309/ })).toBeChecked();
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.queryByText("Claude (dev-box)")).not.toBeInTheDocument();
  });

  it("opens the model under the selected row only", () => {
    renderChoice({ layout: "grouped", runtimes: grouped, modelLabel: "Model label" });

    const selectedRow = screen.getByRole("radio", { name: /Claude/ }).parentElement;
    const otherRow = screen.getByRole("radio", { name: /Codex.*0\.149\.1/ }).parentElement;
    expect(selectedRow).toHaveTextContent("Model label");
    expect(otherRow).not.toHaveTextContent("Model label");
  });

  it("clears the model when switching runtimes and honours disabled", async () => {
    const onChange = vi.fn();
    const { unmount } = renderChoice({
      layout: "grouped",
      runtimes: grouped,
      value: { runtimeId: "rt-1", model: "opus" },
      onChange,
    });

    await userEvent.click(screen.getByRole("radio", { name: /Codex.*0\.149\.1/ }));
    expect(onChange).toHaveBeenCalledWith({ runtimeId: "rt-2", model: "" });
    unmount();

    onChange.mockClear();
    renderChoice({ layout: "grouped", runtimes: grouped, disabled: true, onChange });
    await userEvent.click(screen.getByRole("radio", { name: /Codex.*0\.149\.1/ }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
