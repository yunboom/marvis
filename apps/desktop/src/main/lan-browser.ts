import { networkInterfaces } from "os";
import { Bonjour } from "bonjour-service";
import {
  normalizeServerAddress,
  type DiscoveredServer,
  type ProbeResult,
} from "../shared/server-discovery";
import type { probeServer } from "./server-probe";

// DNS-SD 服务类型 _marvis._tcp，bonjour-service 的 type 不带下划线。
const MARVIS_SERVICE_TYPE = "marvis";

// 通告 TXT 里用到的键。只在探测判定版本过旧时兜底，其余身份信息以 /api/config 为准。
const TXT_KEY_NAME = "name";
const TXT_KEY_VERSION = "ver";
const TXT_KEY_ID = "id";

const MAX_PORT = 65535;

// bonjour-service 的 Service 在浏览时给出的字段子集；多网卡时 addresses 里有多个 IP。
export interface MdnsService {
  fqdn: string;
  name: string;
  host: string;
  port: number;
  addresses?: string[];
  // 收到该通告的数据包来源，addresses 为空时用它判断是否在本机。
  referer?: { address: string };
  txt?: Record<string, unknown>;
}

export interface LanBrowserDeps {
  // 开始浏览 _marvis._tcp，返回停止浏览的函数。
  browse: (
    onUp: (svc: MdnsService) => void,
    onDown: (svc: MdnsService) => void,
  ) => () => void;
  probe: typeof probeServer;
  // 本机所有网卡地址，用来判断发现的服务器是否就在本机。
  localAddresses: () => string[];
}

export interface LanBrowser {
  // 开始浏览并在列表变化时回调；重复调用会先释放上一次的浏览。
  start(onChange: (list: DiscoveredServer[]) => void): void;
  stop(): void;
  // 重新发起浏览，并并发重新核实所有已知服务器。
  rescan(): void;
}

// 一条 mDNS 通告及其核实结果。result 为 null 表示探测还没返回。
interface Advert {
  url: string;
  host: string;
  addresses: string[];
  txtName: string;
  txtVersion: string;
  txtId: string;
  result: ProbeResult | null;
}

// 局域网服务器浏览器：通告 -> 候选 URL -> 并发探测 /api/config -> 按实例去重。
export function createLanBrowser(deps: LanBrowserDeps): LanBrowser {
  let onChange: ((list: DiscoveredServer[]) => void) | null = null;
  let stopBrowse: (() => void) | null = null;
  // 每次 start / stop 加一，用来丢弃上一轮遗留的探测结果。
  let generation = 0;
  let lastEmitted = "[]";

  // 以通告的 fqdn 为键；同一台服务器可以有多条通告。
  const adverts = new Map<string, Advert>();
  // 每个候选 URL 只探测一次。
  const probes = new Map<string, Promise<ProbeResult>>();

  function ensureProbe(url: string): void {
    if (probes.has(url)) return;

    const startedAt = generation;
    // 立即同步发出请求；probeServer 自身不会抛错，这里兜底桩或将来替换的实现。
    const pending = (async () => deps.probe(url))().catch(
      (): ProbeResult => ({ kind: "unreachable" }),
    );
    probes.set(url, pending);

    void pending.then((result) => {
      if (startedAt !== generation || probes.get(url) !== pending) return;

      for (const advert of adverts.values()) {
        if (advert.url === url) advert.result = result;
      }
      emit();
    });
  }

  // 没有通告再使用某个 URL 时，丢掉它的探测缓存，下次出现时重新核实。
  function releaseUrl(url: string): void {
    for (const advert of adverts.values()) {
      if (advert.url === url) return;
    }
    probes.delete(url);
  }

  function handleUp(svc: MdnsService): void {
    const url = candidateUrl(svc);
    if (!url) return;

    const key = svc.fqdn || url;
    const existing = adverts.get(key);
    const announced = advertFromService(svc, url);

    if (existing && existing.url === url) {
      // 同一条通告再次出现：只刷新地址和 TXT，不重新探测。
      Object.assign(existing, announced, { result: existing.result });
      emit();
      return;
    }

    adverts.set(key, { ...announced, result: null });
    if (existing) releaseUrl(existing.url);
    ensureProbe(url);
  }

  function handleDown(svc: MdnsService): void {
    const url = candidateUrl(svc);
    const key = svc.fqdn || url;
    if (!key) return;

    const existing = adverts.get(key);
    if (!existing) return;

    adverts.delete(key);
    releaseUrl(existing.url);
    emit();
  }

  function buildList(): DiscoveredServer[] {
    const local = new Set(deps.localAddresses().map(normalizeAddress));
    const groups = new Map<string, { server: DiscoveredServer; addresses: string[] }>();

    for (const advert of adverts.values()) {
      const server = toDiscovered(advert);
      if (!server) continue;

      // 同一实例的多条通告合并成一项；没有实例 ID 时退回到 URL。
      const key = server.instanceId || server.url;
      const group = groups.get(key);
      if (group) {
        group.addresses.push(...advert.addresses);
      } else {
        groups.set(key, { server, addresses: [...advert.addresses] });
      }
    }

    return [...groups.values()]
      .map(({ server, addresses }) => ({
        ...server,
        isLocal: addresses.some((address) => local.has(normalizeAddress(address))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.url.localeCompare(b.url));
  }

  function emit(): void {
    if (!onChange) return;

    const list = buildList();
    const serialized = JSON.stringify(list);
    if (serialized === lastEmitted) return;

    lastEmitted = serialized;
    onChange(list);
  }

  function stop(): void {
    generation += 1;
    onChange = null;
    adverts.clear();
    probes.clear();
    lastEmitted = "[]";

    const release = stopBrowse;
    stopBrowse = null;
    release?.();
  }

  return {
    start(callback) {
      stop();

      onChange = callback;
      stopBrowse = deps.browse(handleUp, handleDown);
    },

    stop,

    rescan() {
      if (!onChange) return;

      stopBrowse?.();

      // 已知服务器并发重新核实；结果回来之前列表保持不变。
      const urls = new Set([...adverts.values()].map((advert) => advert.url));
      for (const url of urls) {
        probes.delete(url);
        ensureProbe(url);
      }

      stopBrowse = deps.browse(handleUp, handleDown);
    },
  };
}

// 由通告的主机名和端口生成候选 URL。用主机名而不是 IP：地址变了名字不变。
function candidateUrl(svc: MdnsService): string | null {
  const host = svc.host.trim().replace(/\.$/, "");
  if (host === "") return null;
  if (!Number.isInteger(svc.port) || svc.port <= 0 || svc.port > MAX_PORT) return null;

  return normalizeServerAddress(`http://${host}:${svc.port}`);
}

function advertFromService(svc: MdnsService, url: string): Omit<Advert, "result"> {
  const addresses = [...(svc.addresses ?? [])];
  if (svc.referer?.address) addresses.push(svc.referer.address);

  return {
    url,
    host: new URL(url).hostname,
    addresses,
    txtName: txtValue(svc.txt, TXT_KEY_NAME) || svc.name,
    txtVersion: txtValue(svc.txt, TXT_KEY_VERSION),
    txtId: txtValue(svc.txt, TXT_KEY_ID),
  };
}

// 探测通过时用 /api/config 的身份；版本过旧的服务器没有身份可核实，
// 只能用通告里的信息并标记为不兼容；其余结果（不可达、不是 Marvis）不展示。
function toDiscovered(advert: Advert): DiscoveredServer | null {
  const result = advert.result;
  if (!result) return null;

  if (result.kind === "ok") {
    return { ...result.server, isLocal: false, compatible: true };
  }

  if (result.kind === "too_old") {
    return {
      url: advert.url,
      name: advert.txtName,
      version: advert.txtVersion,
      instanceId: advert.txtId,
      host: advert.host,
      appUrl: "",
      isLocal: false,
      compatible: false,
    };
  }

  return null;
}

function txtValue(txt: Record<string, unknown> | undefined, key: string): string {
  const value = txt?.[key];

  return typeof value === "string" ? value.trim() : "";
}

// IPv6 地址去掉网卡后缀（fe80::1%en0）并统一小写，便于比较。
function normalizeAddress(address: string): string {
  return address.split("%")[0]!.toLowerCase();
}

// 生产实现：用 bonjour-service 浏览 _marvis._tcp。每次浏览独占一个 mDNS 套接字，
// 停止时一并销毁，没人订阅时不占用端口。
export function browseBonjour(
  onUp: (svc: MdnsService) => void,
  onDown: (svc: MdnsService) => void,
): () => void {
  const bonjour = new Bonjour();

  // multicast-dns 在端口被占用或无权限时发出 error 事件，不接住会变成主进程的未捕获异常。
  // bonjour-service 没有公开这个事件，只能从内部的 server 上取。
  bonjour["server"].mdns.on("error", (err: unknown) => {
    console.warn("[lan] mDNS error:", err);
  });

  const browser = bonjour.find({ type: MARVIS_SERVICE_TYPE }, onUp);
  browser.on("down", onDown);

  return () => {
    browser.stop();
    bonjour.destroy();
  };
}

// 本机所有网卡的地址。
export function listLocalAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((infos) =>
    (infos ?? []).map((info) => info.address),
  );
}
