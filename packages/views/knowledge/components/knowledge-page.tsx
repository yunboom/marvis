"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronDown, Plus } from "lucide-react";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeBaseListOptions, type KnowledgeBase } from "@marvis/core/knowledge";
import type { Agent } from "@marvis/core/types";
import { agentListOptions } from "@marvis/core/workspace/queries";
import { Button } from "@marvis/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { CollectionPageState } from "../../layout/collection-page";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KnowledgeIcon } from "../lib/knowledge-icon";
import { CreateKnowledgeDialog } from "./create-knowledge-dialog";
import { KnowledgeGapsTab } from "./knowledge-gaps-tab";
import { KnowledgeHistoryTab } from "./knowledge-history-tab";
import { KnowledgePagesWorkspace } from "./knowledge-pages-workspace";
import { KnowledgeReviewTab } from "./knowledge-review-tab";
import { KnowledgeSearch } from "./knowledge-search";
import { KnowledgeSettingsTab } from "./knowledge-settings-tab";

export const KNOWLEDGE_TABS = ["pages", "review", "annotations", "gaps", "graph", "history", "settings"] as const;
export type KnowledgeTab = (typeof KNOWLEDGE_TABS)[number];

const TAB_TRIGGER = "h-full flex-none rounded-none px-0.5 group-data-horizontal/tabs:after:-bottom-px";

function isKnowledgeTab(value: string | null): value is KnowledgeTab {
  return !!value && (KNOWLEDGE_TABS as readonly string[]).includes(value);
}

export function KnowledgePage() {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: bases = [], isLoading, error } = useQuery(knowledgeBaseListOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));

  const params = new URLSearchParams(navigation.searchParams);
  const requestedSlug = params.get("kb");
  const requestedTab = params.get("tab");
  const tab: KnowledgeTab = isKnowledgeTab(requestedTab) ? requestedTab : "pages";
  const kb = bases.find((b) => b.slug === requestedSlug) ?? bases[0] ?? null;

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(navigation.searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    navigation.replace(`${navigation.pathname}${next.size ? `?${next}` : ""}${navigation.hash}`);
  };

  const maintainerName = kb?.maintainer_agent_id
    ? (agents.find((a) => a.id === kb.maintainer_agent_id)?.name ?? t(($) => $.page.no_maintainer))
    : t(($) => $.page.no_maintainer);

  if (error) {
    return (
      <CollectionPageState
        role="alert"
        tone="destructive"
        icon={AlertCircle}
        title={error instanceof Error ? error.message : t(($) => $.errors.load)}
      />
    );
  }

  if (isLoading) {
    return (
      <div className={`flex flex-col gap-3 pt-6 ${PAGE_GUTTER}`}>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {kb ? (
        <Tabs
          className="flex min-h-0 flex-1 flex-col gap-0"
          value={tab}
          onValueChange={(value) => setParams({ tab: value === "pages" ? null : String(value) })}
        >
          <div className={`flex h-18 shrink-0 items-center gap-2.5 ${PAGE_GUTTER}`}>
            <KnowledgeIcon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" className="text-title font-semibold" aria-label={t(($) => $.switcher.label)} />}
              >
                {kb.name}
                <ChevronDown aria-hidden="true" className="size-4 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                {bases.map((b) => (
                  <DropdownMenuItem key={b.id} onClick={() => setParams({ kb: b.slug, page: null })} className="items-start py-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{b.name}</span>
                      {b.description ? (
                        <span className="truncate text-caption text-muted-foreground">{b.description}</span>
                      ) : null}
                    </span>
                    {b.id === kb.id ? <Check aria-hidden="true" className="size-4" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden="true" className="size-4" />
                  {t(($) => $.switcher.create)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-caption text-muted-foreground">
              {t(($) => $.page.summary, { pages: kb.page_count, agent: maintainerName })}
            </span>
            <div className="flex-1" />
            <KnowledgeSearch onOpen={(hit) => setParams({ kb: hit.slug, tab: null, page: hit.path })} />
          </div>
          <div className={`shrink-0 border-b border-border ${PAGE_GUTTER}`}>
            <TabsList variant="line" aria-label={t(($) => $.page.title)} className="gap-5 p-0 group-data-horizontal/tabs:h-10">
              {KNOWLEDGE_TABS.map((key) => (
                <TabsTrigger key={key} value={key} className={TAB_TRIGGER}>
                  {t(($) => $.tabs[key])}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {KNOWLEDGE_TABS.map((key) => (
            <TabsContent key={key} value={key} className="flex min-h-0 flex-1 flex-col data-hidden:hidden">
              <KnowledgeTabBody
                tab={key}
                kb={kb}
                bases={bases}
                agents={agents}
                onDeleted={() => setParams({ kb: null, tab: null, page: null })}
                onOpenChange={(number) => setParams({ tab: "review", change: String(number) })}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <CollectionPageState
          icon={KnowledgeIcon}
          title={t(($) => $.empty.title)}
          description={t(($) => $.empty.description)}
          actions={<Button onClick={() => setCreateOpen(true)}>{t(($) => $.empty.create)}</Button>}
        />
      )}
      <CreateKnowledgeDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        agents={agents}
        onCreated={(created) => setParams({ kb: created.slug, tab: null, page: null })}
      />
    </div>
  );
}

function KnowledgeTabBody({
  tab,
  kb,
  bases,
  agents,
  onDeleted,
  onOpenChange,
}: {
  tab: KnowledgeTab;
  kb: KnowledgeBase;
  bases: KnowledgeBase[];
  agents: Agent[];
  onDeleted: () => void;
  onOpenChange: (number: number) => void;
}) {
  switch (tab) {
    case "pages":
      return <KnowledgePagesWorkspace kb={kb} onOpenChange={onOpenChange} />;
    case "review":
      return <KnowledgeReviewTab bases={bases} />;
    case "gaps":
      return <KnowledgeGapsTab />;
    case "history":
      return <KnowledgeHistoryTab bases={bases} onReverted={onOpenChange} />;
    case "settings":
      return <KnowledgeSettingsTab kb={kb} agents={agents} isLast={bases.length === 1} onDeleted={onDeleted} />;
    default:
      return null;
  }
}
