import type { KbGraph } from "@marvis/core/types";

/** Where a node sits in the graph's view box. */
export interface KbGraphPoint {
  x: number;
  y: number;
}

/** View box of the graph drawing. */
export const KB_GRAPH_WIDTH = 860;
export const KB_GRAPH_HEIGHT = 700;

const MARGIN = 48;
const ITERATIONS = 300;

/**
 * Lays a graph out with a small force simulation: linked nodes pull
 * together, every pair pushes apart, and nodes of one group start next to
 * each other. Deterministic, so the drawing does not jump between renders.
 */
export function layoutKbGraph(graph: KbGraph): Map<string, KbGraphPoint> {
  const nodes = graph.nodes;
  const out = new Map<string, KbGraphPoint>();
  if (nodes.length === 0) return out;

  const cx = KB_GRAPH_WIDTH / 2;
  const cy = KB_GRAPH_HEIGHT / 2;
  const groups = [...new Set(nodes.map((node) => node.group))];

  // Start each group on its own sector of a circle.
  const pos = nodes.map((node, i) => {
    const sector = (groups.indexOf(node.group) / Math.max(groups.length, 1)) * Math.PI * 2;
    const angle = sector + (i % 7) * 0.12;
    const radius = 120 + (i % 5) * 30;
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
  const index = new Map(nodes.map((node, i) => [node.key, i]));
  const links = graph.edges.flatMap((edge) => {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    return a === undefined || b === undefined ? [] : [[a, b] as const];
  });

  const ideal = Math.max(60, Math.min(140, Math.sqrt((KB_GRAPH_WIDTH * KB_GRAPH_HEIGHT) / nodes.length) * 0.6));
  for (let step = 0; step < ITERATIONS; step++) {
    const cooling = 1 - step / ITERATIONS;
    const force = pos.map(() => ({ x: 0, y: 0 }));

    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i]!;
        const b = pos[j]!;
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const dist2 = Math.max(dx * dx + dy * dy, 1);
        const push = (ideal * ideal) / dist2;
        force[i]!.x += dx * push * 0.05;
        force[i]!.y += dy * push * 0.05;
        force[j]!.x -= dx * push * 0.05;
        force[j]!.y -= dy * push * 0.05;
      }
    }
    for (const [i, j] of links) {
      const a = pos[i]!;
      const b = pos[j]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const pull = (dist - ideal) / dist;
      force[i]!.x += dx * pull * 0.1;
      force[i]!.y += dy * pull * 0.1;
      force[j]!.x -= dx * pull * 0.1;
      force[j]!.y -= dy * pull * 0.1;
    }
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]!;
      // A weak pull to the centre keeps unlinked nodes on the canvas.
      force[i]!.x += (cx - p.x) * 0.01;
      force[i]!.y += (cy - p.y) * 0.01;
      const limit = 20 * cooling + 1;
      p.x += Math.max(-limit, Math.min(limit, force[i]!.x));
      p.y += Math.max(-limit, Math.min(limit, force[i]!.y));
    }
  }

  // Fit into the view box.
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const scale = Math.min(
    (KB_GRAPH_WIDTH - MARGIN * 2) / Math.max(maxX - minX, 1),
    (KB_GRAPH_HEIGHT - MARGIN * 2) / Math.max(maxY - minY, 1),
    1.5,
  );
  const offsetX = (KB_GRAPH_WIDTH - (maxX - minX) * scale) / 2;
  const offsetY = (KB_GRAPH_HEIGHT - (maxY - minY) * scale) / 2;
  nodes.forEach((node, i) => {
    out.set(node.key, { x: offsetX + (pos[i]!.x - minX) * scale, y: offsetY + (pos[i]!.y - minY) * scale });
  });

  return out;
}

/** Keys of the nodes linked to a node, the node itself included. */
export function kbGraphNeighbours(graph: KbGraph, key: string): Set<string> {
  const out = new Set([key]);
  for (const edge of graph.edges) {
    if (edge.from === key) out.add(edge.to);
    if (edge.to === key) out.add(edge.from);
  }
  return out;
}
