"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeKeys, knowledgeSearchOptions, type KnowledgeSearchHit } from "@marvis/core/knowledge";
import { Input } from "@marvis/ui/components/ui/input";
import { useT } from "../../i18n";

const DEBOUNCE_MS = 250;

export function KnowledgeSearch({ onOpen }: { onOpen: (hit: KnowledgeSearchHit) => void }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [loggedQuery, setLoggedQuery] = useState<string | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  const { data, isFetching } = useQuery(knowledgeSearchOptions(wsId, query));
  const hits = data?.hits ?? [];
  const showResults = query.length > 0;
  const noHits = showResults && !isFetching && hits.length === 0;

  const recordGap = async () => {
    if (!noHits || loggedQuery === query) return;
    await api.searchKnowledge(query, { recordMiss: true });
    setLoggedQuery(query);
    await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
  };

  return (
    <div className="relative w-64">
      <Search aria-hidden="true" className="pointer-events-none absolute top-2.5 left-3 size-3.5 text-muted-foreground" />
      <Input
        aria-label={t(($) => $.search.label)}
        placeholder={t(($) => $.search.placeholder)}
        className="pl-8"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setInput("");
          if (e.key === "Enter") void recordGap();
        }}
      />
      {showResults ? (
        <div
          role="listbox"
          aria-label={t(($) => $.search.results)}
          className="absolute top-11 right-0 left-0 z-30 rounded-xl bg-popover p-1.5 shadow-menu"
        >
          {hits.map((hit) => (
            <button
              key={hit.path}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                setInput("");
                onOpen(hit);
              }}
              className="flex w-full flex-col items-start rounded-row px-2.5 py-2 text-left hover:bg-accent"
            >
              <span className="text-body">{hit.title}</span>
              <span className="w-full truncate text-caption text-muted-foreground">{hit.excerpt || hit.path}</span>
            </button>
          ))}
          {noHits ? (
            <div className="px-2.5 py-2 text-body">
              <div>{t(($) => $.search.no_results, { query })}</div>
              <div className={loggedQuery === query ? "mt-1 text-caption text-status-done" : "mt-1 text-caption text-muted-foreground"}>
                {loggedQuery === query ? t(($) => $.search.gap_logged) : t(($) => $.search.press_enter)}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
