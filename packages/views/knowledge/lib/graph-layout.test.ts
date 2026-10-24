// @vitest-environment node
import { describe, expect, it } from "vitest";
import { layoutGraph, neighborsOf } from "./graph-layout";

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("layoutGraph", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ];

  it("keeps every node inside the margins and is deterministic", () => {
    const first = layoutGraph(ids, edges, 400, 300, 20);
    const second = layoutGraph(ids, edges, 400, 300, 20);
    for (const id of ids) {
      const p = first.get(id)!;
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(380);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(280);
      expect(second.get(id)).toEqual(p);
    }
  });

  it("pulls linked pages closer together than unlinked ones", () => {
    const pos = layoutGraph(ids, edges, 400, 300);
    const linked = (dist(pos.get("a")!, pos.get("b")!) + dist(pos.get("b")!, pos.get("c")!)) / 2;
    const unlinked = (dist(pos.get("d")!, pos.get("e")!) + dist(pos.get("e")!, pos.get("f")!)) / 2;
    expect(linked).toBeLessThan(unlinked);
  });

  it("handles empty and single-node graphs and ignores dangling edges", () => {
    expect(layoutGraph([], [], 100, 100).size).toBe(0);
    expect(layoutGraph(["a"], [{ from: "a", to: "gone" }], 100, 100).get("a")).toEqual({ x: 50, y: 50 });
  });
});

describe("neighborsOf", () => {
  it("collects links in both directions", () => {
    expect([...neighborsOf("b", [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "d", to: "e" }])].sort()).toEqual(["a", "c"]);
  });
});
