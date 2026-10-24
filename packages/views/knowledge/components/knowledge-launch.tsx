"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { chatSessionsOptions } from "@marvis/core/chat/queries";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  knowledgeKeys,
  knowledgePageListOptions,
  type KnowledgeAnnotation,
  type KnowledgeBase,
  type KnowledgeChangeRequest,
  type KnowledgeGap,
  type KnowledgeSessionKind,
} from "@marvis/core/knowledge";
import type { Agent } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Checkbox } from "@marvis/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@marvis/ui/components/ui/select";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { KnowledgeSessionPanel, useSendToSession, type OpenKnowledgeSession } from "./knowledge-session";

export type KnowledgeOperation =
  | { kind: "fix"; annotations: KnowledgeAnnotation[] }
  | { kind: "ingest"; items: string[] }
  | { kind: "fresh" }
  | { kind: "merge"; pages: string[] }
  | { kind: "merge"; from: KnowledgeBase; into: KnowledgeBase }
  | { kind: "gap"; gaps: KnowledgeGap[] }
  | { kind: "rebase"; change: KnowledgeChangeRequest }
  | { kind: "create" };

/** Starts knowledge sessions and owns the dialogs around them (agent picker, ingest, merge, the session window). */
export function useKnowledgeLauncher({
  kb,
  bases,
  agents,
  onOpenChange,
  onOpenAnnotations,
  onCreated,
}: {
  kb: KnowledgeBase | null;
  bases: KnowledgeBase[];
  agents: Agent[];
  onOpenChange: (number: number) => void;
  onOpenAnnotations: () => void;
  onCreated: (kb: KnowledgeBase) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const send = useSendToSession();
  const [session, setSession] = useState<OpenKnowledgeSession | null>(null);
  const [picking, setPicking] = useState<KnowledgeOperation | null>(null);
  const [ingestOpen, setIngestOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? t(($) => $.session.agent_fallback);

  const firstMessage = (op: KnowledgeOperation, sessionId: string, target: KnowledgeBase | null): string | null => {
    const footer = t(($) => $.session.first.footer, { slug: target?.slug ?? "", session: sessionId });
    const kbName = target?.name ?? "";
    switch (op.kind) {
      case "fix":
        return [
          t(($) => $.session.first.fix, { kb: kbName, n: op.annotations.length }),
          ...op.annotations.map((a) =>
            t(($) => (a.quote && !a.anchor_lost ? $.session.first.annotation_line : $.session.first.annotation_page), {
              id: a.id,
              page: a.page_path,
              quote: a.quote,
              body: a.body,
            }),
          ),
          footer,
        ].join("\n");
      case "ingest":
        return [t(($) => $.session.first.ingest, { kb: kbName }), ...op.items.map((i) => `- ${i}`), footer].join("\n");
      case "fresh":
        return [t(($) => $.session.first.fresh, { kb: kbName }), footer].join("\n");
      case "merge":
        return "pages" in op
          ? [t(($) => $.session.first.merge_pages, { kb: kbName }), ...op.pages.map((p) => `- ${p}`), footer].join("\n")
          : [t(($) => $.session.first.merge_kb, { from: op.from.name, fromSlug: op.from.slug, into: op.into.name, intoSlug: op.into.slug }), footer].join("\n");
      case "gap":
        return [t(($) => $.session.first.gap, { kb: kbName }), ...op.gaps.map((g) => `- ${g.question}`), footer].join("\n");
      case "rebase":
        return [t(($) => $.session.first.rebase, { number: op.change.number, branch: op.change.branch }), footer].join("\n");
      case "create":
        return null;
    }
  };

  const start = async (op: KnowledgeOperation, agentId?: string) => {
    const target = op.kind === "create" ? null : op.kind === "merge" && "into" in op ? op.into : kb;
    if (!agentId && !target?.maintainer_agent_id) {
      setPicking(op);
      return;
    }
    setStarting(true);
    try {
      const created = await api.createKnowledgeSession({
        kind: op.kind as KnowledgeSessionKind,
        knowledge_base_id: target?.id,
        agent_id: agentId,
      });
      if (!created) return;
      const message = firstMessage(op, created.session_id, target);
      if (message) await send(created.session_id, message);
      await qc.invalidateQueries({ queryKey: knowledgeKeys.bases(wsId) });
      setPicking(null);
      setSession({
        sessionId: created.session_id,
        kind: op.kind,
        agentName: agentName(created.maintainer_agent_id),
        kb: target,
        startedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setPicking(op);
      else toast.error(err instanceof Error ? err.message : t(($) => $.session.start_failed));
    } finally {
      setStarting(false);
    }
  };

  const dialogs = (
    <>
      {picking ? (
        <AgentPickerDialog
          kbName={picking.kind === "create" ? null : (kb?.name ?? "")}
          agents={agents}
          busy={starting}
          onCancel={() => setPicking(null)}
          onPick={(id) => void start(picking, id)}
        />
      ) : null}
      {ingestOpen && kb ? (
        <IngestDialog
          kb={kb}
          onCancel={() => setIngestOpen(false)}
          onStart={(items) => {
            setIngestOpen(false);
            void start({ kind: "ingest", items });
          }}
        />
      ) : null}
      {mergeOpen && kb ? (
        <MergeDialog
          kb={kb}
          bases={bases}
          onCancel={() => setMergeOpen(false)}
          onStart={(op) => {
            setMergeOpen(false);
            void start(op);
          }}
        />
      ) : null}
      {session ? (
        <KnowledgeSessionPanel
          session={session}
          onClose={() => setSession(null)}
          onOpenChange={(n) => {
            setSession(null);
            onOpenChange(n);
          }}
          onOpenAnnotations={() => {
            setSession(null);
            onOpenAnnotations();
          }}
          onCreateFromDraft={async (draft) => {
            try {
              const created = await api.createKnowledgeBase({ name: draft.name, description: draft.description, purpose: draft.purpose });
              await qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });
              toast.success(t(($) => $.create.created, { name: created.name }));
              setSession(null);
              onCreated(created);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : t(($) => $.create.failed));
            }
          }}
        />
      ) : null}
    </>
  );

  return {
    launch: (op: KnowledgeOperation) => void start(op),
    openIngest: () => setIngestOpen(true),
    openMerge: () => setMergeOpen(true),
    openSession: (s: OpenKnowledgeSession) => setSession(s),
    starting,
    dialogs,
  };
}

function AgentPickerDialog({
  kbName,
  agents,
  busy,
  onCancel,
  onPick,
}: {
  kbName: string | null;
  agents: Agent[];
  busy: boolean;
  onCancel: () => void;
  onPick: (agentId: string) => void;
}) {
  const { t } = useT("knowledge");
  const [choice, setChoice] = useState<string | null>(null);
  const usable = agents.filter((a) => !a.archived_at);

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{kbName ? t(($) => $.picker.title, { kb: kbName }) : t(($) => $.picker.title_create)}</DialogTitle>
          <DialogDescription>{kbName ? t(($) => $.picker.description) : t(($) => $.picker.description_create)}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t(($) => $.fields.maintainer)} className="flex flex-col gap-1">
          {usable.length === 0 ? <p className="text-body text-muted-foreground">{t(($) => $.picker.none)}</p> : null}
          {usable.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={choice === a.id}
              onClick={() => setChoice(a.id)}
              className={cn("flex items-center gap-3 rounded-row px-3 py-2.5 text-left hover:bg-accent", choice === a.id && "bg-secondary")}
            >
              <span className="min-w-0 flex-1 truncate text-body">{a.name}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t(($) => $.common.cancel)}
          </Button>
          <Button disabled={!choice || busy} aria-busy={busy} onClick={() => choice && onPick(choice)}>
            {t(($) => $.picker.continue)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type IngestSource = "url" | "issue" | "chat";

function IngestDialog({ kb, onCancel, onStart }: { kb: KnowledgeBase; onCancel: () => void; onStart: (items: string[]) => void }) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const [source, setSource] = useState<IngestSource>("url");
  const [urls, setUrls] = useState("");
  const [issues, setIssues] = useState("");
  const [chats, setChats] = useState<Record<string, boolean>>({});
  const { data: sessions = [] } = useQuery({ ...chatSessionsOptions(wsId), enabled: source === "chat" });

  const items = [
    ...urls.split("\n").map((u) => u.trim()).filter(Boolean),
    ...issues.split(/[\s,，]+/).map((k) => k.trim()).filter(Boolean).map((k) => t(($) => $.ingest.issue_item, { key: k })),
    ...sessions.filter((s) => chats[s.id]).map((s) => t(($) => $.ingest.chat_item, { title: s.title, id: s.id })),
  ];

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.ingest.title, { kb: kb.name })}</DialogTitle>
          <DialogDescription>{t(($) => $.ingest.description)}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t(($) => $.ingest.source)} className="flex gap-1">
          {(["url", "issue", "chat"] as const).map((s) => (
            <Button key={s} size="xs" role="radio" aria-checked={source === s} variant={source === s ? "secondary" : "ghost"} onClick={() => setSource(s)}>
              {t(($) => $.ingest.sources[s])}
            </Button>
          ))}
        </div>
        <div className="min-h-40">
          {source === "url" ? (
            <div className="space-y-1.5">
              <Label htmlFor="kb-ingest-urls">{t(($) => $.ingest.urls)}</Label>
              <Textarea id="kb-ingest-urls" rows={4} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={t(($) => $.ingest.urls_placeholder)} />
            </div>
          ) : null}
          {source === "issue" ? (
            <div className="space-y-1.5">
              <Label htmlFor="kb-ingest-issues">{t(($) => $.ingest.issues)}</Label>
              <Input id="kb-ingest-issues" value={issues} onChange={(e) => setIssues(e.target.value)} placeholder={t(($) => $.ingest.issues_placeholder)} />
            </div>
          ) : null}
          {source === "chat" ? (
            <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              <p className="text-caption text-muted-foreground">{t(($) => $.ingest.own_chats_only)}</p>
              {sessions.map((s) => (
                <label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded-row px-2 py-1.5 hover:bg-accent">
                  <Checkbox checked={!!chats[s.id]} onCheckedChange={(v) => setChats((c) => ({ ...c, [s.id]: !!v }))} />
                  <span className="min-w-0 flex-1 truncate text-body">{s.title || s.id}</span>
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <p className="text-caption text-muted-foreground">{t(($) => $.ingest.files_hint)}</p>
        <DialogFooter>
          <span className="mr-auto self-center text-caption text-muted-foreground">{t(($) => $.ingest.selected_n, { n: items.length })}</span>
          <Button variant="outline" onClick={onCancel}>
            {t(($) => $.common.cancel)}
          </Button>
          <Button onClick={() => onStart(items)}>{t(($) => $.ingest.start)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MergeDialog({
  kb,
  bases,
  onCancel,
  onStart,
}: {
  kb: KnowledgeBase;
  bases: KnowledgeBase[];
  onCancel: () => void;
  onStart: (op: KnowledgeOperation) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const [mode, setMode] = useState<"pages" | "kb">("pages");
  const [otherKbId, setOtherKbId] = useState(kb.id);
  const [pageA, setPageA] = useState<string | null>(null);
  const [pageB, setPageB] = useState<string | null>(null);
  const [fromId, setFromId] = useState<string | null>(bases.find((b) => b.id !== kb.id)?.id ?? null);
  const { data: pagesA } = useQuery(knowledgePageListOptions(wsId, kb.id));
  const { data: pagesB } = useQuery(knowledgePageListOptions(wsId, otherKbId));
  const from = bases.find((b) => b.id === fromId) ?? null;

  const pageItems = (list: typeof pagesA) => (list?.pages ?? []).map((p) => ({ value: p.path, label: `${p.title} · ${p.path}` }));
  const ready = mode === "pages" ? !!pageA && !!pageB && pageA !== pageB : !!from && from.id !== kb.id;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onCancel())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.merge.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.merge.description)}</DialogDescription>
        </DialogHeader>
        <div role="radiogroup" aria-label={t(($) => $.merge.mode)} className="flex gap-1">
          {(["pages", "kb"] as const).map((m) => (
            <Button key={m} size="xs" role="radio" aria-checked={mode === m} variant={mode === m ? "secondary" : "ghost"} onClick={() => setMode(m)}>
              {t(($) => $.merge.modes[m])}
            </Button>
          ))}
        </div>
        {mode === "pages" ? (
          <div className="flex flex-col gap-3">
            <SimpleSelect id="kb-merge-a" label={t(($) => $.merge.page_a, { kb: kb.name })} items={pageItems(pagesA)} value={pageA} onChange={setPageA} />
            <SimpleSelect
              id="kb-merge-other"
              label={t(($) => $.merge.other_kb)}
              items={bases.map((b) => ({ value: b.id, label: b.name }))}
              value={otherKbId}
              onChange={(v) => {
                setOtherKbId(v ?? kb.id);
                setPageB(null);
              }}
            />
            <SimpleSelect id="kb-merge-b" label={t(($) => $.merge.page_b)} items={pageItems(pagesB)} value={pageB} onChange={setPageB} />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <SimpleSelect
              id="kb-merge-from"
              label={t(($) => $.merge.from)}
              items={bases.filter((b) => b.id !== kb.id).map((b) => ({ value: b.id, label: b.name }))}
              value={fromId}
              onChange={setFromId}
            />
            <p className="text-body">{t(($) => $.merge.into, { kb: kb.name })}</p>
            <p className="text-caption text-muted-foreground">{t(($) => $.merge.kb_hint)}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t(($) => $.common.cancel)}
          </Button>
          <Button
            disabled={!ready}
            onClick={() =>
              mode === "pages"
                ? onStart({ kind: "merge", pages: [pageA ?? "", pageB ?? ""] })
                : from && onStart({ kind: "merge", from, into: kb })
            }
          >
            {t(($) => $.merge.start)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SimpleSelect({
  id,
  label,
  items,
  value,
  onChange,
}: {
  id: string;
  label: string;
  items: { value: string; label: string }[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const current = items.find((i) => i.value === value);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select items={items} value={value ?? ""} onValueChange={(v) => onChange(v ? String(v) : null)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{() => current?.label ?? ""}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
