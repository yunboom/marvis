import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@marvis/core/i18n/react";
import type { QoderConnection } from "@marvis/core/runtimes/qoder";
import type { AgentRuntime } from "@marvis/core/types";
import enAgents from "../../locales/en/agents.json";
import enRuntimes from "../../locales/en/runtimes.json";
import { buildRuntimeMachines } from "../../runtimes/components/runtime-machines";
import { buildRuntimeChoiceGroups } from "./runtime-choice";
import {
  RuntimeChoiceList,
  qoderChoiceState,
  type RuntimeChoiceListProps,
} from "./runtime-choice-list";

const NOW = Date.now();

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "runtime-1",
    workspace_id: "ws-1",
    daemon_id: "daemon-local",
    name: "Claude (my-mac)",
    runtime_mode: "local",
    provider: "claude",
    launch_header: "",
    status: "online",
    device_info: "my-mac",
    metadata: {},
    owner_id: "me",
    visibility: "private",
    last_seen_at: new Date(NOW - 10_000).toISOString(),
    created_at: "2026-10-18T11:00:00Z",
    updated_at: "2026-10-18T11:00:00Z",
    ...overrides,
  };
}

const LOCAL_PROVIDERS = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "kimi",
  "opencode",
  "openclaw",
  "qwen",
  "kiro",
];

const runtimes = [
  ...LOCAL_PROVIDERS.map((provider) =>
    makeRuntime({ id: `local-${provider}`, provider, name: `${provider} (my-mac)` }),
  ),
  makeRuntime({
    id: "server-claude",
    daemon_id: "daemon-server",
    name: "Claude (build-01)",
    device_info: "build-01",
    owner_id: "teammate",
    visibility: "public",
  }),
];

const groups = buildRuntimeChoiceGroups(
  buildRuntimeMachines(runtimes, {
    now: NOW,
    localDaemonId: "daemon-local",
    currentUserId: "me",
  }),
  "me",
);

const unconnectedQoder: QoderConnection = {
  available: true,
  configured: false,
  name: "",
  baseUrl: "https://api.qoder.com/api/v1/cloud",
  environmentId: "",
  hasToken: false,
  repositories: [],
  enabled: false,
  status: "stopped",
  lastError: "",
  maxConcurrency: 3,
  runTimeoutMinutes: 60,
  activeRuns: 0,
  queuedRuns: 0,
};

function mount(overrides: Partial<RuntimeChoiceListProps> = {}) {
  const props: RuntimeChoiceListProps = {
    local: groups.local,
    localAvailable: true,
    localStarting: false,
    remotes: groups.remotes,
    hiddenRemoteCount: 0,
    cloud: [],
    qoder: unconnectedQoder,
    qoderState: qoderChoiceState(unconnectedQoder, false),
    qoderSelected: false,
    selectedRuntimeId: null,
    query: "",
    currentUserId: "me",
    canManage: true,
    ownerName: (id) => (id === "teammate" ? "Bohan" : null),
    onSelect: vi.fn(),
    onSelectQoder: vi.fn(),
    onConnectQoder: vi.fn(),
    onManageQoder: vi.fn(),
    onAddRemote: vi.fn(),
    ...overrides,
  };
  render(
    <I18nProvider
      locale="en"
      resources={{ en: { agents: enAgents, runtimes: enRuntimes } }}
    >
      <RuntimeChoiceList {...props} />
    </I18nProvider>,
  );
  return props;
}

afterEach(() => {
  cleanup();
});

describe("RuntimeChoiceList", () => {
  it("opens this machine, folds harnesses past six, and keeps other machines closed", () => {
    const props = mount();

    expect(screen.getByRole("button", { name: /my-mac/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("button", { name: /^3 more:/ })).toBeInTheDocument();
    const server = screen.getByRole("button", { name: /build-01/ });
    expect(server).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: /^3 more:/ }));
    expect(screen.queryByRole("button", { name: /^3 more:/ })).not.toBeInTheDocument();

    fireEvent.click(server);
    expect(server).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(props.onSelect).toHaveBeenCalledWith("server-claude");
  });

  it("opens the machine holding the selection and warns about a teammate's account", () => {
    mount({ selectedRuntimeId: "server-claude" });

    expect(screen.getByRole("button", { name: /build-01/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText(/Tasks run on Bohan's machine/)).toBeInTheDocument();
  });

  it("lists only Claude under cloud services, tagged not yet available", () => {
    mount();
    // Qoder and Cursor are hidden from the group for now (runtimes/cloud-services.ts).
    expect(screen.queryByText("Qoder Cloud Agents")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor Cloud Agents")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();

    const claude = screen.getByText("Claude Managed Agents").closest("[aria-disabled='true']");
    expect(claude).not.toBeNull();
    expect(claude).toHaveTextContent("Not yet available");
    expect(claude).not.toHaveTextContent("Anthropic");
  });

  it("reports an unconfigured Qoder when the server cannot encrypt credentials", () => {
    const qoder = { ...unconnectedQoder, available: false };
    expect(qoderChoiceState({ ...qoder, configured: true, enabled: true, status: "online" }, true))
      .toBe("not_configured");
  });

  it("says so when nothing matches the search", () => {
    mount({ query: "zzz" });
    expect(screen.getByText("Nothing matches “zzz”")).toBeInTheDocument();
  });
});
