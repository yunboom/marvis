"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { EMPTY_KNOWLEDGE_GRAPH as EMPTY_GRAPH, knowledgeGraphOptions, type KnowledgeBase } from "@marvis/core/knowledge";
import { cn } from "@marvis/ui/lib/utils";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import { layoutGraph, neighborsOf } from "../lib/graph-layout";

const WIDTH = 800;
const HEIGHT = 520;
const LABEL_MIN_DEGREE = 2;

// One national-pigment status colour per page group; unknown groups fall back to muted.
const GROUP_FILL: Record<string, string> = {
  entities: "fill-status-progress",
  concepts: "fill-status-review",
  howtos: "fill-status-done",
  decisions: "fill-status-blocked",
  syntheses: "fill-status-todo",
  sources: "fill-status-idle",
};
const GROUP_BG: Record<string, string> = {
  entities: "bg-status-progress",
  concepts: "bg-status-review",
  howtos: "bg-status-done",
  decisions: "bg-status-blocked",
  syntheses: "bg-status-todo",
  sources: "bg-status-idle",
};
const KNOWN_GROUPS = ["entities", "concepts", "howtos", "decisions", "syntheses", "sources", "queries"] as const;
type KnownGroup = (typeof KNOWN_GROUPS)[number];

function nodeRadius(degree: number) {
  return 5 + Math.min(degree, 8);
}

/** Link graph of a knowledge base: hover highlights neighbours, click opens the page, orphans are dashed. */
export function KnowledgeGraphTab({ kb, onOpenPage }: { kb: KnowledgeBase; onOpenPage: (path: string) => void }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const { data: graph } = useQuery(knowledgeGraphOptions(wsId, kb.id));
  const [hovered, setHovered] = useState<string | null>(null);

  const nodes = graph?.nodes ?? EMPTY_GRAPH.nodes;
  const edges = graph?.edges ?? EMPTY_GRAPH.edges;
  const positions = useMemo(() => layoutGraph(nodes.map((n) => n.path), edges, WIDTH, HEIGHT), [nodes, edges]);
  const highlight = useMemo(() => {
    if (!hovered) return null;
    const set = neighborsOf(hovered, edges);
    set.add(hovered);
    return set;
  }, [hovered, edges]);
  const groups = useMemo(
    () => KNOWN_GROUPS.filter((g) => nodes.some((n) => n.group === g)),
    [nodes],
  );

  if (!graph) return null;
  if (nodes.length === 0) {
    return <div className={`py-10 text-center text-body text-muted-foreground ${PAGE_GUTTER}`}>{t(($) => $.graph.empty)}</div>;
  }

  return (
    <div className={`flex flex-1 flex-col gap-3 overflow-y-auto py-6 ${PAGE_GUTTER}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
        {groups.map((g) => (
          <span key={g} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-2 rounded-full", GROUP_BG[g] ?? "bg-muted-foreground")} />
            {t(($) => $.groups[g as KnownGroup])}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="size-2 rounded-full border border-dashed border-muted-foreground" />
          {t(($) => $.graph.orphan)}
        </span>
      </div>
      <svg
        role="img"
        aria-label={t(($) => $.graph.aria)}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="w-full max-w-4xl rounded-lg border border-border bg-background"
      >
        <g>
          {edges.map((e) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return null;
            const active = !highlight || (highlight.has(e.from) && highlight.has(e.to));
            return (
              <line
                key={`${e.from}->${e.to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={cn("stroke-border transition-opacity duration-(--motion-fast)", active ? "opacity-100" : "opacity-20")}
                strokeWidth={1}
              />
            );
          })}
        </g>
        <g>
          {nodes.map((n) => {
            const p = positions.get(n.path);
            if (!p) return null;
            const orphan = n.degree === 0;
            const dimmed = highlight && !highlight.has(n.path);
            const r = nodeRadius(n.degree);
            const label = n.title || n.path;
            return (
              <g
                key={n.path}
                role="button"
                tabIndex={0}
                aria-label={t(($) => $.graph.open, { title: label })}
                className={cn("cursor-pointer outline-none transition-opacity duration-(--motion-fast)", dimmed ? "opacity-25" : "opacity-100")}
                onMouseEnter={() => setHovered(n.path)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(n.path)}
                onBlur={() => setHovered(null)}
                onClick={() => onOpenPage(n.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenPage(n.path);
                  }
                }}
              >
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  className={cn(
                    orphan ? "fill-background stroke-muted-foreground" : (GROUP_FILL[n.group] ?? "fill-muted-foreground"),
                    hovered === n.path && "stroke-foreground",
                  )}
                  strokeWidth={orphan || hovered === n.path ? 1.5 : 0}
                  strokeDasharray={orphan ? "3 2" : undefined}
                />
                {n.degree >= LABEL_MIN_DEGREE || hovered === n.path ? (
                  <text x={p.x} y={p.y - r - 4} textAnchor="middle" className="fill-foreground text-caption select-none">
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
