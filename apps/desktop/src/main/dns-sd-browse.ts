import { spawn } from "child_process";
import { createInterface } from "readline";
import type { LanBrowserDeps, MdnsService } from "./lan-browser";

// macOS 自带的 dns-sd 命令，经系统 mDNSResponder 收发组播。系统 Bonjour 在防火墙白名单里；
// 应用自己开 5353 端口收组播时，防火墙开着“阻止所有传入连接”就收不到其他机器的回应。
const DNS_SD_PATH = "/usr/bin/dns-sd";

const SERVICE_TYPE = "_marvis._tcp";
const SERVICE_DOMAIN = "local.";

// 解析一台服务器时每一步（-L 取主机名和端口、-G 取 IPv4）的超时。
const RESOLVE_STEP_TIMEOUT_MS = 5000;

// dns-sd 输出里 A/R 列表示上线的值。
const EVENT_ADDED = "Add";
// Flags 列里“后面还有结果”的位。
const FLAG_MORE_COMING = 0x1;
// 查询不到地址时 dns-sd 给出的占位地址。
const UNSPECIFIED_IPV4 = "0.0.0.0";

// -B 的一行：时间、Add/Rmv、Flags、网卡序号、域、服务类型、实例名（原样输出，可含空格）。
const BROWSE_LINE = /^\S+\s+(Add|Rmv)\s+[0-9A-Fa-f]+\s+(\d+)\s+\S+\s+\S+\s+(.+)$/;
// -L 的一行：<完整服务名> can be reached at <主机名>:<端口> (interface N)
const RESOLVE_LINE = / can be reached at (\S+):(\d+) \(interface \d+\)/;
// -G 的一行：时间、Add/Rmv、Flags、网卡序号、主机名、地址、TTL。
const ADDRESS_LINE = /^\S+\s+(Add|Rmv)\s+([0-9A-Fa-f]+)\s+\d+\s+\S+\s+(\S+)\s+\d+/;
const IPV4_ADDRESS = /^\d{1,3}(\.\d{1,3}){3}$/;

// 一个运行中的 dns-sd 进程。
export interface DnsSdProcess {
  stop(): void;
}

// 启动 dns-sd 并逐行回调它的标准输出。
export type RunDnsSd = (args: string[], onLine: (line: string) => void) => DnsSdProcess;

// -B 输出的一条上线 / 下线事件。同一实例在每块网卡（含回环）上各报一次。
export interface BrowseEvent {
  added: boolean;
  interfaceIndex: string;
  name: string;
}

export function parseBrowseLine(line: string): BrowseEvent | null {
  const match = BROWSE_LINE.exec(line);
  if (!match) return null;

  return { added: match[1] === EVENT_ADDED, interfaceIndex: match[2]!, name: match[3]! };
}

export function parseResolveLine(line: string): { host: string; port: number } | null {
  const match = RESOLVE_LINE.exec(line);
  if (!match) return null;

  return { host: match[1]!, port: Number(match[2]) };
}

// -L 在解析结果的下一行打印 TXT：以空格开头，条目之间用空格分隔，
// 值里的空格和 shell 特殊字符前加反斜杠。
export function parseTxtLine(line: string): Record<string, string> {
  const txt: Record<string, string> = {};

  for (const entry of splitEscaped(line)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;

    txt[entry.slice(0, separator)] = entry.slice(separator + 1);
  }

  return txt;
}

// -G 的一条地址结果；address 为 null 表示这一行没有可用的 IPv4。
export function parseAddressLine(line: string): { address: string | null; moreComing: boolean } | null {
  const match = ADDRESS_LINE.exec(line);
  if (!match) return null;

  const address = match[3]!;
  const usable = match[1] === EVENT_ADDED && IPV4_ADDRESS.test(address) && address !== UNSPECIFIED_IPV4;

  return {
    address: usable ? address : null,
    moreComing: (parseInt(match[2]!, 16) & FLAG_MORE_COMING) !== 0,
  };
}

function splitEscaped(line: string): string[] {
  const entries: string[] = [];
  let current = "";

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === "\\") {
      i += 1;
      current += line[i] ?? "";
    } else if (char === " ") {
      if (current) entries.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) entries.push(current);

  return entries;
}

// 一次 dns-sd 查询的输出收集器：feed 返回 undefined 表示还要继续读；timeout 给出超时时的结果。
interface Collector<T> {
  feed(line: string): T | undefined;
  timeout(): T;
}

interface Query<T> {
  result: Promise<T>;
  cancel(): void;
}

// 运行一次 dns-sd 查询，拿到结果、超时或取消后结束进程。
function query<T>(run: RunDnsSd, args: string[], timeoutMs: number, collector: Collector<T>): Query<T> {
  let settled = false;
  let resolveResult: (value: T) => void = () => {};
  const result = new Promise<T>((resolve) => {
    resolveResult = resolve;
  });

  const settle = (value: T) => {
    if (settled) return;

    settled = true;
    clearTimeout(timer);
    proc.stop();
    resolveResult(value);
  };

  const proc = run(args, (line) => {
    if (settled) return;

    const value = collector.feed(line);
    if (value !== undefined) settle(value);
  });
  const timer = setTimeout(() => settle(collector.timeout()), timeoutMs);

  return { result, cancel: () => settle(collector.timeout()) };
}

interface Lookup {
  host: string;
  port: number;
  txt: Record<string, string>;
}

// -L 可能连续给出多条解析结果，取第一条；结果后面紧跟的以空格开头的行是它的 TXT。
function lookupCollector(): Collector<Lookup | null> {
  let found: Lookup | null = null;

  return {
    feed(line) {
      if (found) return line.startsWith(" ") ? { ...found, txt: parseTxtLine(line) } : found;

      const target = parseResolveLine(line);
      if (target) found = { ...target, txt: {} };

      return undefined;
    },
    timeout: () => found,
  };
}

// -G 逐条给出地址，Flags 不再带“后面还有结果”时收齐。
function addressCollector(): Collector<string[]> {
  const addresses: string[] = [];

  return {
    feed(line) {
      const answer = parseAddressLine(line);
      if (!answer) return undefined;

      if (answer.address) addresses.push(answer.address);

      return answer.moreComing ? undefined : addresses;
    },
    timeout: () => addresses,
  };
}

function serviceFqdn(name: string): string {
  return `${name}.${SERVICE_TYPE}.${SERVICE_DOMAIN}`;
}

// 解析一个实例：-L 取主机名、端口和 TXT，再用 -G 取主机名的 IPv4。没解析出来时结果为 null。
function resolveService(run: RunDnsSd, name: string, timeoutMs: number): Query<MdnsService | null> {
  let current: Query<unknown> | null = null;
  let cancelled = false;

  const result = (async () => {
    const lookup = query(run, ["-L", name, SERVICE_TYPE, SERVICE_DOMAIN], timeoutMs, lookupCollector());
    current = lookup;
    const target = await lookup.result;
    if (cancelled || !target) return null;

    const addresses = query(run, ["-G", "v4", target.host], timeoutMs, addressCollector());
    current = addresses;
    const ips = await addresses.result;
    if (cancelled) return null;

    return {
      fqdn: serviceFqdn(name),
      name,
      host: target.host,
      port: target.port,
      addresses: ips,
      txt: target.txt,
    };
  })();

  return {
    result,
    cancel: () => {
      cancelled = true;
      current?.cancel();
    },
  };
}

// 用 dns-sd 浏览 _marvis._tcp，接口与 browseBonjour 相同。
export function createDnsSdBrowse(
  run: RunDnsSd,
  timeoutMs = RESOLVE_STEP_TIMEOUT_MS,
): LanBrowserDeps["browse"] {
  return (onUp, onDown) => {
    // 实例名 -> 报告它在线的网卡；所有网卡都报下线才算下线。
    const interfaces = new Map<string, Set<string>>();
    // 正在解析的实例。
    const resolving = new Map<string, Query<MdnsService | null>>();
    // 已经通知上线的实例。
    const announced = new Set<string>();

    function handleAdded(name: string, interfaceIndex: string): void {
      const seen = interfaces.get(name) ?? new Set<string>();
      seen.add(interfaceIndex);
      interfaces.set(name, seen);
      if (seen.size > 1) return;

      const pending = resolveService(run, name, timeoutMs);
      resolving.set(name, pending);

      void pending.result.then((svc) => {
        if (resolving.get(name) !== pending) return;

        resolving.delete(name);
        if (!svc) return;

        announced.add(name);
        onUp(svc);
      });
    }

    function handleRemoved(name: string, interfaceIndex: string): void {
      const seen = interfaces.get(name);
      if (!seen) return;

      seen.delete(interfaceIndex);
      if (seen.size > 0) return;

      interfaces.delete(name);
      resolving.get(name)?.cancel();
      resolving.delete(name);

      if (announced.delete(name)) {
        onDown({ fqdn: serviceFqdn(name), name, host: "", port: 0 });
      }
    }

    const browser = run(["-B", SERVICE_TYPE, SERVICE_DOMAIN], (line) => {
      const event = parseBrowseLine(line);
      if (!event) return;

      if (event.added) {
        handleAdded(event.name, event.interfaceIndex);
      } else {
        handleRemoved(event.name, event.interfaceIndex);
      }
    });

    return () => {
      browser.stop();
      for (const pending of resolving.values()) pending.cancel();
      resolving.clear();
    };
  };
}

// 生产实现：启动 /usr/bin/dns-sd 逐行读输出。输出到管道时 dns-sd 也是逐行刷新的。
export function runDnsSd(args: string[], onLine: (line: string) => void): DnsSdProcess {
  const child = spawn(DNS_SD_PATH, args, { stdio: ["ignore", "pipe", "ignore"] });

  // 启动失败时 child 发出 error 事件，不接住会变成主进程的未捕获异常。
  child.on("error", (err) => {
    console.warn("[lan] dns-sd error:", err);
  });
  createInterface({ input: child.stdout }).on("line", onLine);

  return {
    stop: () => {
      child.kill();
    },
  };
}

// macOS 上的局域网浏览：经系统 Bonjour 发现，不受应用防火墙拦截。
export const browseDnsSd = createDnsSdBrowse(runDnsSd);
