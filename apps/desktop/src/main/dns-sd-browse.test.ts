// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDnsSdBrowse,
  parseAddressLine,
  parseBrowseLine,
  parseResolveLine,
  parseTxtLine,
  type RunDnsSd,
} from "./dns-sd-browse";
import type { MdnsService } from "./lan-browser";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// 以下输出行取自 macOS 上 dns-sd 的真实输出。
const BROWSE_ADD_EN0 = "16:54:00.156  Add        2  11 local.               _marvis._tcp.        DJ-mayunpeng";
const BROWSE_ADD_LO0 = "16:54:00.156  Add        3   1 local.               _marvis._tcp.        DJ-mayunpeng";
const BROWSE_RMV_EN0 = "16:58:00.100  Rmv        0  11 local.               _marvis._tcp.        DJ-mayunpeng";
const BROWSE_RMV_LO0 = "16:58:00.100  Rmv        0   1 local.               _marvis._tcp.        DJ-mayunpeng";
const RESOLVED =
  "16:54:09.150  DJ-mayunpeng._marvis._tcp.local. can be reached at marvis.local.:13840 (interface 11) Flags: 1";
const TXT = " v=1 name=DJ-mayunpeng ver=0.6.5 id=298a71c9-0fcc-4a50-bd44-474bf83ef9ab";
const ADDRESS =
  "16:54:11.018  Add  40000002      11  marvis.local.                          10.192.20.119                                120";

// 可控的 dns-sd：记录每次启动的参数，由测试逐行喂输出。
function fakeDnsSd() {
  const procs: { args: string[]; emit: (line: string) => void; stopped: boolean }[] = [];
  const run: RunDnsSd = (args, onLine) => {
    const proc = { args, emit: onLine, stopped: false };
    procs.push(proc);

    return {
      stop: () => {
        proc.stopped = true;
      },
    };
  };
  const last = (flag: string) => procs.filter((proc) => proc.args[0] === flag).at(-1)!;

  return { run, procs, last };
}

function setup() {
  const dnsSd = fakeDnsSd();
  const up: MdnsService[] = [];
  const down: MdnsService[] = [];
  const stop = createDnsSdBrowse(dnsSd.run, 5000)(
    (svc) => up.push(svc),
    (svc) => down.push(svc),
  );

  return { ...dnsSd, up, down, stop };
}

// 让一个实例走完 -L 和 -G。
async function resolveFully(dnsSd: ReturnType<typeof setup>) {
  dnsSd.last("-L").emit(RESOLVED);
  dnsSd.last("-L").emit(TXT);
  await flush();
  dnsSd.last("-G").emit(ADDRESS);
  await flush();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("dns-sd output parsing", () => {
  it("parses browse events and keeps names with spaces", () => {
    expect(parseBrowseLine(BROWSE_ADD_EN0)).toEqual({ added: true, interfaceIndex: "11", name: "DJ-mayunpeng" });
    expect(parseBrowseLine(BROWSE_RMV_LO0)).toEqual({ added: false, interfaceIndex: "1", name: "DJ-mayunpeng" });
    expect(
      parseBrowseLine("16:55:57.733  Add        3   1 local.               _marvis._tcp.        设计部 Marvis.1"),
    ).toEqual({ added: true, interfaceIndex: "1", name: "设计部 Marvis.1" });
  });

  it("ignores browse headers", () => {
    expect(parseBrowseLine("Browsing for _marvis._tcp.local.")).toBeNull();
    expect(parseBrowseLine("16:54:00.155  ...STARTING...")).toBeNull();
    expect(
      parseBrowseLine("Timestamp     A/R    Flags  if Domain               Service Type         Instance Name"),
    ).toBeNull();
  });

  it("parses the resolved host and port", () => {
    expect(parseResolveLine(RESOLVED)).toEqual({ host: "marvis.local.", port: 13840 });
    expect(parseResolveLine("Lookup DJ-mayunpeng._marvis._tcp.local.")).toBeNull();
  });

  it("parses escaped TXT values", () => {
    expect(parseTxtLine(TXT)).toEqual({
      v: "1",
      name: "DJ-mayunpeng",
      ver: "0.6.5",
      id: "298a71c9-0fcc-4a50-bd44-474bf83ef9ab",
    });
    expect(parseTxtLine(' name=设计部\\ Marvis\\&x ver= id=q\\"t')).toEqual({
      name: "设计部 Marvis&x",
      ver: "",
      id: 'q"t',
    });
  });

  it("parses addresses and the more-coming flag", () => {
    expect(parseAddressLine(ADDRESS)).toEqual({ address: "10.192.20.119", moreComing: false });
    expect(parseAddressLine(ADDRESS.replace("40000002", "40000003"))).toEqual({
      address: "10.192.20.119",
      moreComing: true,
    });
    expect(parseAddressLine(ADDRESS.replace("10.192.20.119", "0.0.0.0"))).toEqual({
      address: null,
      moreComing: false,
    });
    expect(
      parseAddressLine("Timestamp     A/R  Flags         IF  Hostname          Address          TTL"),
    ).toBeNull();
  });
});

describe("createDnsSdBrowse", () => {
  it("resolves host, port, TXT and IPv4 before reporting a server", async () => {
    const dnsSd = setup();
    expect(dnsSd.procs[0]!.args).toEqual(["-B", "_marvis._tcp", "local."]);

    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);
    expect(dnsSd.last("-L").args).toEqual(["-L", "DJ-mayunpeng", "_marvis._tcp", "local."]);

    await resolveFully(dnsSd);

    expect(dnsSd.last("-G").args).toEqual(["-G", "v4", "marvis.local."]);
    expect(dnsSd.up).toEqual([
      {
        fqdn: "DJ-mayunpeng._marvis._tcp.local.",
        name: "DJ-mayunpeng",
        host: "marvis.local.",
        port: 13840,
        addresses: ["10.192.20.119"],
        txt: { v: "1", name: "DJ-mayunpeng", ver: "0.6.5", id: "298a71c9-0fcc-4a50-bd44-474bf83ef9ab" },
      },
    ]);
    expect(dnsSd.last("-L").stopped).toBe(true);
    expect(dnsSd.last("-G").stopped).toBe(true);
  });

  it("collects every address until the more-coming flag clears", async () => {
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);
    dnsSd.last("-L").emit(RESOLVED);
    dnsSd.last("-L").emit(TXT);
    await flush();

    dnsSd.last("-G").emit(ADDRESS.replace("40000002", "40000003").replace("10.192.20.119", "169.254.3.4"));
    await flush();
    expect(dnsSd.up).toHaveLength(0);

    dnsSd.last("-G").emit(ADDRESS);
    await flush();
    expect(dnsSd.up[0]!.addresses).toEqual(["169.254.3.4", "10.192.20.119"]);
  });

  it("reports a server once per instance and down only after every interface drops it", async () => {
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_LO0);
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);
    expect(dnsSd.procs.filter((proc) => proc.args[0] === "-L")).toHaveLength(1);

    await resolveFully(dnsSd);
    expect(dnsSd.up).toHaveLength(1);

    dnsSd.procs[0]!.emit(BROWSE_RMV_EN0);
    expect(dnsSd.down).toHaveLength(0);

    dnsSd.procs[0]!.emit(BROWSE_RMV_LO0);
    expect(dnsSd.down).toEqual([{ fqdn: "DJ-mayunpeng._marvis._tcp.local.", name: "DJ-mayunpeng", host: "", port: 0 }]);
  });

  it("drops a server that goes away before it resolves", async () => {
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);
    dnsSd.procs[0]!.emit(BROWSE_RMV_EN0);

    expect(dnsSd.last("-L").stopped).toBe(true);

    dnsSd.last("-L").emit(RESOLVED);
    dnsSd.last("-L").emit(TXT);
    await flush();
    expect(dnsSd.procs.some((proc) => proc.args[0] === "-G")).toBe(false);
    expect(dnsSd.up).toHaveLength(0);
    expect(dnsSd.down).toHaveLength(0);
  });

  it("gives up when the lookup times out", async () => {
    vi.useFakeTimers();
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);

    await vi.advanceTimersByTimeAsync(5000);

    expect(dnsSd.last("-L").stopped).toBe(true);
    expect(dnsSd.procs.some((proc) => proc.args[0] === "-G")).toBe(false);
    expect(dnsSd.up).toHaveLength(0);
  });

  it("reports the server without TXT when none follows the lookup", async () => {
    vi.useFakeTimers();
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);
    dnsSd.last("-L").emit(RESOLVED);

    await vi.advanceTimersByTimeAsync(5000);
    dnsSd.last("-G").emit(ADDRESS);
    await vi.advanceTimersByTimeAsync(0);

    expect(dnsSd.up[0]!.txt).toEqual({});
    expect(dnsSd.up[0]!.port).toBe(13840);
  });

  it("stops the browse and every pending lookup", () => {
    const dnsSd = setup();
    dnsSd.procs[0]!.emit(BROWSE_ADD_EN0);

    dnsSd.stop();

    expect(dnsSd.procs.every((proc) => proc.stopped)).toBe(true);
  });
});
