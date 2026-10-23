import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRuntime } from "@marvis/core/types";
import { I18nProvider } from "@marvis/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enOnboarding from "../../locales/en/onboarding.json";

const TEST_RESOURCES = { en: { common: enCommon, onboarding: enOnboarding } };

// Drive the runtime picker via a hoisted mock so the step renders without a
// live daemon.
const mocks = vi.hoisted(() => ({
  pickerState: {
    runtimes: [] as AgentRuntime[],
    selected: null as AgentRuntime | null,
    selectedId: null as string | null,
    setSelectedId: vi.fn<(id: string) => void>(),
    hasRuntimes: false,
  },
}));

vi.mock("../components/use-runtime-picker", () => ({
  useRuntimePicker: () => mocks.pickerState,
}));

// The real choice renders a model dropdown that fetches the runtime's models.
vi.mock("../../runtimes/components/mika-runtime-choice", () => ({
  MikaRuntimeChoice: ({
    runtimes,
    onChange,
  }: {
    runtimes: AgentRuntime[];
    onChange: (next: { runtimeId: string; model: string }) => void;
  }) => (
    <div>
      {runtimes.map((rt) => (
        <span key={rt.id}>{rt.name}</span>
      ))}
      <button
        type="button"
        onClick={() => onChange({ runtimeId: "rt_1", model: "opus" })}
      >
        pick opus
      </button>
    </div>
  ),
}));

import { StepConnectRuntime } from "./step-connect-runtime";

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "rt_1",
    name: "Claude (dev-box)",
    provider: "claude",
    status: "online",
    ...overrides,
  } as AgentRuntime;
}

function renderStep(
  props: { runtimesPending?: boolean; web?: boolean } = {},
) {
  const onNext = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <StepConnectRuntime
          wsId="ws_test"
          onNext={onNext}
          runtimesPending={props.runtimesPending}
          cliInstructions={props.web ? <p>install commands</p> : undefined}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onNext };
}

function useFoundRuntime() {
  const rt = makeRuntime();
  mocks.pickerState.runtimes = [rt];
  mocks.pickerState.selected = rt;
  mocks.pickerState.selectedId = rt.id;
  mocks.pickerState.hasRuntimes = true;
}

describe("StepConnectRuntime", () => {
  beforeEach(() => {
    mocks.pickerState.runtimes = [];
    mocks.pickerState.selected = null;
    mocks.pickerState.selectedId = null;
    mocks.pickerState.hasRuntimes = false;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps Start with Mika disabled until a runtime is found", () => {
    renderStep();

    expect(screen.getByRole("button", { name: "Start with Mika" })).toBeDisabled();
  });

  it("flips to the empty state after the idle timeout when no pending signal is given", () => {
    renderStep();

    expect(
      screen.getByText("Looking for AI coding tools on this computer..."),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5000));

    expect(
      screen.getByText("No AI coding tools on this computer yet"),
    ).toBeInTheDocument();
  });

  // Past the soft budget the daemon still reports work in flight, so the
  // false-negative empty state must not appear (MUL-5119); the hard ceiling
  // still guarantees a fallback for a wedged probe.
  it("keeps scanning while runtimes are pending, then falls back at the hard ceiling", () => {
    renderStep({ runtimesPending: true });

    act(() => vi.advanceTimersByTime(5000));
    expect(
      screen.getByText("Looking for AI coding tools on this computer..."),
    ).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(15000));
    expect(
      screen.getByText("No AI coding tools on this computer yet"),
    ).toBeInTheDocument();
  });

  it("starts Mika on the chosen runtime and model", () => {
    useFoundRuntime();
    const { onNext } = renderStep();

    expect(screen.getByText("Claude (dev-box)")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "pick opus" }));
    fireEvent.click(screen.getByRole("button", { name: "Start with Mika" }));

    expect(onNext).toHaveBeenCalledWith(mocks.pickerState.selected, "opus");
  });

  it("can always skip", () => {
    const { onNext } = renderStep();

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(onNext).toHaveBeenCalledWith(null);
  });

  it("lays the CLI commands out inline on web while waiting", () => {
    renderStep({ web: true });

    act(() => vi.advanceTimersByTime(20000));

    expect(screen.getByText("install commands")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for your computer to connect"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Download the desktop app" }),
    ).toHaveAttribute("href", "/download");
    expect(
      screen.queryByText("No AI coding tools on this computer yet"),
    ).not.toBeInTheDocument();
  });

  it("swaps the commands for the runtime list once one registers on web", () => {
    useFoundRuntime();
    renderStep({ web: true });

    expect(screen.getByText("Claude (dev-box)")).toBeInTheDocument();
    expect(screen.queryByText("install commands")).not.toBeInTheDocument();
  });
});
