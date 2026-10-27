"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { kbBaseDetailOptions, kbGraphOptions } from "@marvis/core/kb/queries";
import { useWorkspacePaths } from "@marvis/core/paths";
import type { KbGraphNode } from "@marvis/core/types";
import { PageHeader } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbPageCrumb } from "./kb-manage-page";
import { parseKbManageRoute } from "./kb-manage-route";
import { KB_GRAPH_HEIGHT, KB_GRAPH_WIDTH, kbGraphNeighbours, layoutKbGraph } from "./kb-graph-layout";

/** Group colors, in the order groups first appear. */
const GROUP_COLORS = [
  "var(--identity-blue-foreground)",
  "var(--identity-green-foreground)",
  "var(--identity-yellow-foreground)",
  "var(--identity-brown-foreground)",
  "var(--identity-purple-foreground)",
  "var(--identity-gray-foreground)",
];

const DIMMED = 0.22;

function nodeRadius(node: KbGraphNode): number {
  return Math.min(7 + node.degree, 13);
}

/**
 * The relationship graph (designs 2.10–2.11): pages colored by their
 * top-level page, links between them, unlinked pages and pages not yet
 * written as dashed circles. Hover highlights neighbours; click opens a page.
 */
export function KbGraphPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const { pathname, push } = useNavigation();
  const { kbSlug } = parseKbManageRoute(pathname);
  const { data: base } = useQuery(kbBaseDetailOptions(wsId, kbSlug));
  const { data: graph, isLoading } = useQuery(kbGraphOptions(wsId, kbSlug));
  const [hovered, setHovered] = useState<string | null>(null);

  const points = useMemo(() => (graph ? layoutKbGraph(graph) : new Map()), [graph]);
  const groups = useMemo(() => [...new Set((graph?.nodes ?? []).filter((n) => !n.missing).map((n) => n.group))], [graph]);
  const color = (group: string) => GROUP_COLORS[Math.max(groups.indexOf(group), 0) % GROUP_COLORS.length]!;
  const near = useMemo(() => (graph && hovered ? kbGraphNeighbours(graph, hovered) : null), [graph, hovered]);
  const hoveredNode = graph?.nodes.find((node) => node.key === hovered) ?? null;
  const hoveredPoint = hovered ? points.get(hovered) : undefined;

  const open = (node: KbGraphNode) => {
    if (node.id) push(p.kbPage(kbSlug, node.id));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader>
        <KbPageCrumb kbSlug={kbSlug} name={base?.name ?? kbSlug} title={t(($) => $.graph.title)} />
      </PageHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
        <div aria-label={t(($) => $.graph.legend)} className="flex flex-wrap items-center gap-4 text-label text-muted-foreground">
          {groups.map((group) => (
            <span key={group} className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-[9px] rounded-full" style={{ background: color(group) }} />
              {group}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-[9px] rounded-full border border-dashed border-faint-foreground" />
            {t(($) => $.graph.no_links)}
          </span>
          <span className="flex-1" />
          <span className="text-faint-foreground">{t(($) => $.graph.hint)}</span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card">
          {!isLoading && graph && graph.nodes.length === 0 && (
            <p className="absolute inset-0 flex items-center justify-center text-body text-muted-foreground">{t(($) => $.graph.empty)}</p>
          )}
          {graph && graph.nodes.length > 0 && (
            <svg
              viewBox={`0 0 ${KB_GRAPH_WIDTH} ${KB_GRAPH_HEIGHT}`}
              width="100%"
              height="100%"
              role="img"
              aria-label={t(($) => $.graph.label)}
            >
              <g stroke="var(--border)" strokeWidth={1}>
                {graph.edges.map((edge) => {
                  const a = points.get(edge.from);
                  const b = points.get(edge.to);
                  if (!a || !b) return null;
                  const lit = !near || (near.has(edge.from) && near.has(edge.to) && (edge.from === hovered || edge.to === hovered));
                  return <line key={`${edge.from}>${edge.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} opacity={lit ? 1 : DIMMED} />;
                })}
              </g>
              <g>
                {graph.nodes.map((node) => {
                  const point = points.get(node.key);
                  if (!point) return null;
                  const dashed = node.missing || node.degree === 0;
                  const lit = !near || near.has(node.key);
                  const label = node.missing
                    ? t(($) => $.graph.missing, { title: node.title })
                    : t(($) => $.graph.open, { title: node.title, count: node.degree });
                  return (
                    <g
                      key={node.key}
                      data-testid="kb-graph-node"
                      role={node.id ? "link" : undefined}
                      tabIndex={node.id ? 0 : undefined}
                      aria-label={label}
                      opacity={lit ? 1 : DIMMED}
                      className={node.id ? "cursor-pointer" : undefined}
                      onMouseEnter={() => setHovered(node.key)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(node.key)}
                      onBlur={() => setHovered(null)}
                      onClick={() => open(node)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") open(node);
                      }}
                    >
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r={nodeRadius(node)}
                        fill={dashed ? "var(--background)" : color(node.group)}
                        stroke={dashed ? "var(--faint-foreground)" : node.key === hovered ? "var(--foreground)" : "none"}
                        strokeWidth={dashed ? 1.5 : 2}
                        strokeDasharray={dashed ? "3 2" : undefined}
                      />
                      <text
                        x={point.x}
                        y={point.y + nodeRadius(node) + 14}
                        textAnchor="middle"
                        fontSize={12}
                        fill={node.missing ? "var(--faint-foreground)" : "var(--foreground)"}
                      >
                        {node.title}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
          {hoveredNode && hoveredPoint && (
            <div
              role="tooltip"
              className="pointer-events-none absolute rounded-lg bg-foreground px-2.5 py-1.5 text-label text-background"
              style={{
                left: `${(hoveredPoint.x / KB_GRAPH_WIDTH) * 100}%`,
                top: `${(hoveredPoint.y / KB_GRAPH_HEIGHT) * 100}%`,
                transform: "translate(16px, -140%)",
              }}
            >
              {hoveredNode.missing
                ? t(($) => $.graph.missing, { title: hoveredNode.title })
                : t(($) => $.graph.open, { title: hoveredNode.title, count: hoveredNode.degree })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
