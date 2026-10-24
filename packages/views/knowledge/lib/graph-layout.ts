export interface GraphPoint {
  x: number;
  y: number;
}

const ITERATIONS = 300;

/**
 * Deterministic Fruchterman–Reingold layout. Nodes start on a circle in input
 * order, so the same graph always renders the same way and tests can rely on
 * it. Positions stay inside [margin, size - margin].
 */
export function layoutGraph(
  ids: string[],
  edges: { from: string; to: string }[],
  width: number,
  height: number,
  margin = 24,
): Map<string, GraphPoint> {
  const pos = new Map<string, GraphPoint>();
  const n = ids.length;
  if (n === 0) return pos;

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - margin;
  ids.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / n;
    pos.set(id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
  });
  if (n === 1) {
    pos.set(ids[0]!, { x: cx, y: cy });
    return pos;
  }

  const links = edges.filter((e) => pos.has(e.from) && pos.has(e.to) && e.from !== e.to);
  const k = Math.sqrt(((width - 2 * margin) * (height - 2 * margin)) / n);
  let temperature = Math.min(width, height) / 10;
  const cooling = temperature / ITERATIONS;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const disp = new Map<string, GraphPoint>(ids.map((id) => [id, { x: 0, y: 0 }]));

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const dist = Math.max(Math.hypot(dx, dy), 0.01);
        const force = (k * k) / dist;
        const da = disp.get(ids[i]!)!;
        const db = disp.get(ids[j]!)!;
        da.x += (dx / dist) * force;
        da.y += (dy / dist) * force;
        db.x -= (dx / dist) * force;
        db.y -= (dy / dist) * force;
      }
    }

    for (const e of links) {
      const a = pos.get(e.from)!;
      const b = pos.get(e.to)!;
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const force = (dist * dist) / k;
      const da = disp.get(e.from)!;
      const db = disp.get(e.to)!;
      da.x -= (dx / dist) * force;
      da.y -= (dy / dist) * force;
      db.x += (dx / dist) * force;
      db.y += (dy / dist) * force;
    }

    // Weak pull to the centre keeps unlinked pages from drifting to the edges.
    for (const id of ids) {
      const p = pos.get(id)!;
      const d = disp.get(id)!;
      d.x += (cx - p.x) * 0.02;
      d.y += (cy - p.y) * 0.02;
      const len = Math.max(Math.hypot(d.x, d.y), 0.01);
      const step = Math.min(len, temperature);
      p.x = Math.min(width - margin, Math.max(margin, p.x + (d.x / len) * step));
      p.y = Math.min(height - margin, Math.max(margin, p.y + (d.y / len) * step));
    }
    temperature = Math.max(temperature - cooling, 0.5);
  }

  return pos;
}

/** Paths linked to `path` in either direction. */
export function neighborsOf(path: string, edges: { from: string; to: string }[]): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.from === path) out.add(e.to);
    if (e.to === path) out.add(e.from);
  }

  return out;
}
