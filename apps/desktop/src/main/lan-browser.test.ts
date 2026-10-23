// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type {
  DiscoveredServer,
  ProbeResult,
  ServerIdentity,
} from "../shared/server-discovery";
import { createLanBrowser, type MdnsService } from "./lan-browser";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function advert(overrides: Partial<MdnsService> & { host: string }): MdnsService {
  return {
    fqdn: `${overrides.host}._marvis._tcp.local`,
    name: "设计部 Marvis",
    port: 13840,
    addresses: [],
    txt: { v: "1", name: "设计部 Marvis", ver: "0.6.5", id: "inst-a" },
    ...overrides,
  };
}

function identity(url: string, overrides: Partial<ServerIdentity> = {}): ServerIdentity {
  return {
    url,
    name: "设计部 Marvis",
    version: "0.6.5",
    instanceId: "inst-a",
    host: new URL(url).hostname,
    appUrl: "",
    ...overrides,
  };
}

function ok(url: string, overrides: Partial<ServerIdentity> = {}): ProbeResult {
  return { kind: "ok", server: identity(url, overrides) };
}

// 搭一个可控的浏览器：probe 的结果由测试手动 resolve，up / down 由测试手动触发。
function setup(options: { localAddresses?: string[] } = {}) {
  let up: (svc: MdnsService) => void = () => {};
  let down: (svc: MdnsService) => void = () => {};
  const stopBrowse = vi.fn();
  const browse = vi.fn(
    (onUp: (svc: MdnsService) => void, onDown: (svc: MdnsService) => void) => {
      up = onUp;
      down = onDown;
      return stopBrowse;
    },
  );

  const pending = new Map<string, Array<(result: ProbeResult) => void>>();
  const probe = vi.fn(
    (url: string) =>
      new Promise<ProbeResult>((resolve) => {
        pending.set(url, [...(pending.get(url) ?? []), resolve]);
      }),
  );

  const browser = createLanBrowser({
    browse,
    probe,
    localAddresses: () => options.localAddresses ?? [],
  });
  const onChange = vi.fn<(list: DiscoveredServer[]) => void>();

  return {
    browser,
    browse,
    stopBrowse,
    probe,
    onChange,
    up: (svc: MdnsService) => up(svc),
    down: (svc: MdnsService) => down(svc),
    // 让对某个 URL 的所有待定探测返回同一个结果。
    resolve: (url: string, result: ProbeResult) => {
      for (const resolveProbe of pending.get(url) ?? []) resolveProbe(result);
      pending.delete(url);
    },
    lastList: (): DiscoveredServer[] => onChange.mock.calls.at(-1)?.[0] ?? [],
  };
}

describe("lan browser", () => {
  it("dedupes by instanceId and probes new services concurrently", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    const first = advert({ host: "marvis.local", addresses: ["192.168.1.10"] });
    const sameInstance = advert({ host: "marvis-2.local", addresses: ["10.0.0.5"] });
    const other = advert({
      host: "studio.local",
      addresses: ["192.168.1.20"],
      txt: { v: "1", name: "工作室", ver: "0.6.5", id: "inst-b" },
    });
    t.up(first);
    t.up(sameInstance);
    t.up(other);

    // 三个候选 URL 用通告里的 IPv4 拼成，在任一探测返回之前就已全部发出。
    expect(t.probe.mock.calls.map(([url]) => url)).toEqual([
      "http://192.168.1.10:13840",
      "http://10.0.0.5:13840",
      "http://192.168.1.20:13840",
    ]);
    expect(t.onChange).not.toHaveBeenCalled();

    t.resolve("http://192.168.1.10:13840", ok("http://192.168.1.10:13840"));
    t.resolve("http://10.0.0.5:13840", ok("http://10.0.0.5:13840"));
    t.resolve(
      "http://192.168.1.20:13840",
      ok("http://192.168.1.20:13840", { name: "工作室", instanceId: "inst-b" }),
    );
    await flush();

    expect(t.lastList()).toHaveLength(2);
    expect(t.lastList().map((s) => s.instanceId).sort()).toEqual(["inst-a", "inst-b"]);
    expect(t.probe).toHaveBeenCalledTimes(3);
  });

  it("uses the probe result as the source of truth for identity", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    // 通告里的 TXT 与 /api/config 不一致时，以探测结果为准。
    t.up(advert({ host: "marvis.local" }));
    t.resolve(
      "http://marvis.local:13840",
      ok("http://marvis.local:13840", {
        name: "来自 config 的名字",
        version: "0.7.0",
        instanceId: "inst-real",
        appUrl: "http://marvis.local:3000",
      }),
    );
    await flush();

    expect(t.lastList()).toEqual([
      {
        url: "http://marvis.local:13840",
        name: "来自 config 的名字",
        version: "0.7.0",
        instanceId: "inst-real",
        host: "marvis.local",
        appUrl: "http://marvis.local:3000",
        isLocal: false,
        compatible: true,
      },
    ]);
  });

  it("marks servers on this machine as isLocal and incompatible ones as compatible=false", async () => {
    const t = setup({ localAddresses: ["192.168.1.10", "fe80::1"] });
    t.browser.start(t.onChange);

    t.up(advert({ host: "marvis.local", addresses: ["fe80::1%en0", "192.168.1.10"] }));
    t.up(
      advert({
        host: "studio.local",
        addresses: ["192.168.1.20"],
        txt: { v: "1", name: "工作室", ver: "0.6.5", id: "inst-b" },
      }),
    );
    t.up(
      advert({
        host: "legacy.local",
        addresses: ["192.168.1.30"],
        txt: { v: "1", name: "旧服务器", ver: "0.5.0", id: "inst-old" },
      }),
    );
    t.resolve("http://192.168.1.10:13840", ok("http://192.168.1.10:13840"));
    t.resolve(
      "http://192.168.1.20:13840",
      ok("http://192.168.1.20:13840", { name: "工作室", instanceId: "inst-b" }),
    );
    t.resolve("http://192.168.1.30:13840", { kind: "too_old" });
    await flush();

    const byId = Object.fromEntries(t.lastList().map((s) => [s.instanceId, s]));
    expect(byId["inst-a"]).toMatchObject({ isLocal: true, compatible: true });
    expect(byId["inst-b"]).toMatchObject({ isLocal: false, compatible: true });
    // 版本过旧的服务器没有身份可核实，名称与版本取自通告，标记为不兼容。
    expect(byId["inst-old"]).toMatchObject({
      url: "http://192.168.1.30:13840",
      host: "legacy.local",
      name: "旧服务器",
      version: "0.5.0",
      appUrl: "",
      isLocal: false,
      compatible: false,
    });
  });

  it("falls back to the packet source address when the announcement carries no IPs", async () => {
    const t = setup({ localAddresses: ["192.168.1.10"] });
    t.browser.start(t.onChange);

    t.up(advert({ host: "marvis.local", addresses: [], referer: { address: "192.168.1.10" } }));

    expect(t.probe.mock.calls.map(([url]) => url)).toEqual(["http://192.168.1.10:13840"]);

    t.resolve("http://192.168.1.10:13840", ok("http://192.168.1.10:13840"));
    await flush();

    expect(t.lastList()[0]).toMatchObject({ isLocal: true, host: "marvis.local" });
  });

  it("prefers a private IPv4 and keeps the mDNS host name for display", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(
      advert({
        host: "Marvis.local.",
        addresses: ["fe80::1%en0", "203.0.113.5", "192.168.1.10"],
        referer: { address: "192.168.1.99" },
      }),
    );

    expect(t.probe.mock.calls.map(([url]) => url)).toEqual(["http://192.168.1.10:13840"]);

    t.resolve("http://192.168.1.10:13840", ok("http://192.168.1.10:13840"));
    await flush();

    expect(t.lastList()[0]).toMatchObject({
      url: "http://192.168.1.10:13840",
      host: "marvis.local",
    });
  });

  it("falls back to the host name when the announcement has no IPv4", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "marvis.local", addresses: ["fe80::1%en0"], referer: { address: "fe80::1" } }));

    expect(t.probe.mock.calls.map(([url]) => url)).toEqual(["http://marvis.local:13840"]);
  });

  it("ignores an announcement whose host name cannot go into an address and has no IPv4", () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "evil host.local", addresses: [] }));
    t.up(advert({ host: "evil/x.local", addresses: ["fe80::1"], fqdn: "x._marvis._tcp.local" }));

    expect(t.probe).not.toHaveBeenCalled();
  });

  it("follows a new IPv4 announced for the same service", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    const svc = advert({ host: "marvis.local", addresses: ["192.168.1.10"] });
    t.up(svc);
    t.resolve("http://192.168.1.10:13840", ok("http://192.168.1.10:13840"));
    await flush();

    t.up({ ...svc, addresses: ["192.168.1.31"] });
    t.resolve("http://192.168.1.31:13840", ok("http://192.168.1.31:13840"));
    await flush();

    expect(t.lastList().map((server) => server.url)).toEqual(["http://192.168.1.31:13840"]);
  });

  it("strips control and bidi characters from announced text", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(
      advert({
        host: "legacy.local",
        addresses: ["192.168.1.30"],
        txt: { v: "1", name: "旧\u001b[31m服务器\u202e", ver: "0.5.0\n", id: "inst-old" },
      }),
    );
    t.resolve("http://192.168.1.30:13840", { kind: "too_old" });
    await flush();

    expect(t.lastList()[0]).toMatchObject({ name: "旧[31m服务器", version: "0.5.0" });
  });

  it("hides candidates that are unreachable or not Marvis", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "printer.local" }));
    t.up(advert({ host: "nas.local" }));
    t.resolve("http://printer.local:13840", { kind: "not_marvis" });
    t.resolve("http://nas.local:13840", { kind: "unreachable" });
    await flush();

    expect(t.lastList()).toEqual([]);
  });

  it("removes a server when its last address goes down", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    const first = advert({ host: "marvis.local" });
    const second = advert({ host: "marvis-2.local" });
    t.up(first);
    t.up(second);
    t.resolve("http://marvis.local:13840", ok("http://marvis.local:13840"));
    t.resolve("http://marvis-2.local:13840", ok("http://marvis-2.local:13840"));
    await flush();
    expect(t.lastList()).toHaveLength(1);

    t.down(first);
    expect(t.lastList()).toHaveLength(1);
    expect(t.lastList()[0]?.url).toBe("http://marvis-2.local:13840");

    t.down(second);
    expect(t.lastList()).toEqual([]);
  });

  it("probes again after a server goes down and comes back", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    const svc = advert({ host: "marvis.local" });
    t.up(svc);
    t.resolve("http://marvis.local:13840", ok("http://marvis.local:13840"));
    await flush();
    t.down(svc);
    t.up(svc);

    expect(t.probe).toHaveBeenCalledTimes(2);
  });

  it("does not probe the same service twice when it is announced again", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    const svc = advert({ host: "marvis.local", addresses: ["192.168.1.10"] });
    t.up(svc);
    t.up({ ...svc, txt: { ...svc.txt, ver: "0.6.6" } });

    expect(t.probe).toHaveBeenCalledTimes(1);
  });

  it("ignores announcements without a usable host or port", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "", fqdn: "no-host._marvis._tcp.local" }));
    t.up(advert({ host: "marvis.local", port: 0, fqdn: "no-port._marvis._tcp.local" }));

    expect(t.probe).not.toHaveBeenCalled();
  });

  it("treats a rejected probe as unreachable", async () => {
    const onChange = vi.fn();
    let up: (svc: MdnsService) => void = () => {};
    const browser = createLanBrowser({
      browse: (onUp) => {
        up = onUp;
        return () => {};
      },
      probe: () => Promise.reject(new Error("boom")),
      localAddresses: () => [],
    });
    browser.start(onChange);

    up(advert({ host: "marvis.local" }));
    await flush();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("rescan browses again, re-probes known servers and drops the ones that vanished", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "marvis.local" }));
    t.up(
      advert({
        host: "studio.local",
        txt: { v: "1", name: "工作室", ver: "0.6.5", id: "inst-b" },
      }),
    );
    t.resolve("http://marvis.local:13840", ok("http://marvis.local:13840"));
    t.resolve(
      "http://studio.local:13840",
      ok("http://studio.local:13840", { name: "工作室", instanceId: "inst-b" }),
    );
    await flush();
    expect(t.lastList()).toHaveLength(2);

    t.browser.rescan();

    expect(t.stopBrowse).toHaveBeenCalledTimes(1);
    expect(t.browse).toHaveBeenCalledTimes(2);
    // 已知服务器的重新核实同样是并发发出的，且重扫期间列表保持不变。
    expect(t.probe).toHaveBeenCalledTimes(4);
    expect(t.lastList()).toHaveLength(2);

    t.resolve("http://marvis.local:13840", ok("http://marvis.local:13840"));
    t.resolve("http://studio.local:13840", { kind: "unreachable" });
    await flush();

    expect(t.lastList().map((s) => s.instanceId)).toEqual(["inst-a"]);
  });

  it("stop releases the browse and ignores late probe results", async () => {
    const t = setup();
    t.browser.start(t.onChange);

    t.up(advert({ host: "marvis.local" }));
    t.browser.stop();
    t.resolve("http://marvis.local:13840", ok("http://marvis.local:13840"));
    await flush();

    expect(t.stopBrowse).toHaveBeenCalledTimes(1);
    expect(t.onChange).not.toHaveBeenCalled();
  });

  it("start twice releases the previous browse first", () => {
    const t = setup();

    t.browser.start(t.onChange);
    t.browser.start(t.onChange);

    expect(t.browse).toHaveBeenCalledTimes(2);
    expect(t.stopBrowse).toHaveBeenCalledTimes(1);
  });
});
