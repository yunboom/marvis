import type { AgentRuntime } from "../types";
import { runtimeDisplayName } from "./display";

/** The separator the server puts between host and CLI version in
 *  `device_info` (handler/daemon.go: "<host> · <version>"). */
const DEVICE_INFO_SEPARATOR = " · ";

/**
 * Splits a runtime's `device_info` into the machine it runs on and the CLI
 * version. The server writes "<host> · <version>", "<host>" or "<version>"
 * alone; with no separator the value is a host unless the runtime has no
 * machine name at all, which the caller cannot tell, so it is kept as host.
 */
export function splitRuntimeDeviceInfo(deviceInfo: string | null | undefined): {
  host: string;
  version: string;
} {
  const value = (deviceInfo ?? "").trim();
  const at = value.indexOf(DEVICE_INFO_SEPARATOR);
  if (at < 0) return { host: value, version: "" };

  return {
    host: value.slice(0, at).trim(),
    version: value.slice(at + DEVICE_INFO_SEPARATOR.length).trim(),
  };
}

export interface RuntimeMachineGroup {
  /** Stable key: the daemon id when known, else the host. */
  key: string;
  host: string;
  /** True when any runtime on the machine is online. */
  online: boolean;
  runtimes: RuntimeMachineEntry[];
}

export interface RuntimeMachineEntry {
  runtime: AgentRuntime;
  /** The runtime's name without the " (<host>)" suffix the daemon appends,
   *  since the group header already names the machine. A custom name is
   *  shown as the user wrote it. */
  label: string;
  version: string;
}

function labelWithoutHost(runtime: AgentRuntime, host: string): string {
  const display = runtimeDisplayName(runtime);
  if (runtime.custom_name?.trim() || !host) return display;

  const suffix = ` (${host})`;
  return display.endsWith(suffix) ? display.slice(0, -suffix.length) : display;
}

/**
 * Groups runtimes by the machine they run on, keeping the incoming order both
 * for machines (first appearance) and for runtimes within a machine.
 */
export function groupRuntimesByMachine(
  runtimes: readonly AgentRuntime[],
): RuntimeMachineGroup[] {
  const groups = new Map<string, RuntimeMachineGroup>();

  for (const runtime of runtimes) {
    const { host, version } = splitRuntimeDeviceInfo(runtime.device_info);
    const key = runtime.daemon_id ?? (host || runtime.id);
    let group = groups.get(key);
    if (!group) {
      group = { key, host, online: false, runtimes: [] };
      groups.set(key, group);
    }

    group.online ||= runtime.status === "online";
    group.runtimes.push({ runtime, label: labelWithoutHost(runtime, host), version });
  }

  return [...groups.values()];
}
