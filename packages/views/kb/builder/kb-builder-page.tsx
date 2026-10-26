"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDefaultLayout } from "react-resizable-panels";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  EMPTY_KB_DRAFT,
  decodeKbBuilderInput,
  encodeKbBuilderInput,
  isKbDraftChanged,
  isValidKbSlug,
  kbBaseDetailOptions,
  kbBuilderSessionHasUnsavedChanges,
  kbBuilderSessionListOptions,
  kbCreateRequest,
  kbDraftFromBase,
  kbKeys,
  kbTemplatesOptions,
  kbUpdateRequest,
  mergeKbDraft,
  parseKbDraft,
  stripKbDraft,
  useCreateKnowledgeBase,
  useUpdateKnowledgeBase,
  type KbDraft,
} from "@marvis/core/kb";
import { useWorkspacePaths } from "@marvis/core/paths";
import { runtimeListOptions } from "@marvis/core/runtimes";
import type {
  KbBuilderMode,
  KbBuilderSession,
  KnowledgeBaseDetail,
  KnowledgeBaseSchemaMode,
} from "@marvis/core/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@marvis/ui/components/ui/resizable";
import { BuilderConversation, BuilderSetup } from "../../agents/create/builder-conversation";
import { UnfinishedDraftsBanner } from "../../agents/create/unfinished-drafts";
import { useBuilderSession, type BuilderSessionTransport } from "../../agents/create/use-builder-session";
import { useCreateAgentForm } from "../../agents/create/use-create-agent-form";
import { useBackOrReplace, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbConfigPanel, type KbDraftField } from "./kb-config-panel";
import { parseKbBuilderRoute } from "./kb-builder-route";
import { KbBuilderShell, KbRuntimeChip } from "./kb-builder-shell";
import { useKbDraftSync } from "./use-kb-draft-sync";

const KB_BUILDER_TRANSPORT: BuilderSessionTransport = {
  listKey: (wsId) => kbKeys.builderSessions(wsId),
  switchRuntime: (sessionId, runtimeId) => api.switchKbBuilderRuntime(sessionId, { runtime_id: runtimeId }),
  destroy: (sessionId) => api.deleteKbBuilderSession(sessionId),
};

/** Starter directions of a new knowledge base (design 1.2). */
const NO_SESSIONS: KbBuilderSession[] = [];

const CREATE_STARTERS = ["dev", "qa", "product", "team"] as const;
/** Opening questions of a configuration (design 10.1). */
const CONFIG_QUESTIONS = ["readers", "scope", "structure", "writing"] as const;

/** "You have N unfinished creations / configurations" (designs 1.7–1.8). */
function KbDraftsBanner({
  mode,
  sessions,
  onResume,
}: {
  mode: KbBuilderMode;
  sessions: KbBuilderSession[];
  onResume: (id: string) => void;
}) {
  const { t } = useT("kb");

  return (
    <UnfinishedDraftsBanner
      sessions={sessions}
      onResume={onResume}
      bannerLabel={
        mode === "create"
          ? t(($) => $.builder.drafts_create, { count: sessions.length })
          : t(($) => $.builder.drafts_config, { count: sessions.length })
      }
      dialogTitle={mode === "create" ? t(($) => $.builder.pick_create) : t(($) => $.builder.pick_config)}
      describe={(session) => ({
        title: session.draft?.name.trim() ?? "",
        preview:
          session.last_message_role === "user"
            ? decodeKbBuilderInput(session.last_message_content)
            : stripKbDraft(session.last_message_content),
      })}
    />
  );
}

/**
 * The step before a conversation exists: choose where the builder runs. The
 * runtime is frozen onto the hidden carrier when the session starts.
 */
function KbBuilderSetupStep({
  mode,
  base,
  sessions,
  onOpen,
}: {
  mode: KbBuilderMode;
  base: KnowledgeBaseDetail | undefined;
  sessions: KbBuilderSession[];
  onOpen: (sessionId: string, runtimeId: string | null) => void;
}) {
  const { t } = useT("kb");
  const paths = useWorkspacePaths();
  const form = useCreateAgentForm();
  const { draft, setDraft, selectedRuntime } = form;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banner = <KbDraftsBanner mode={mode} sessions={sessions} onResume={(id) => onOpen(id, null)} />;

  const start = async () => {
    if (selectedRuntime?.status !== "online") return;
    if (mode === "config" && !base?.id) return;

    setStarting(true);
    setError(null);
    try {
      const session = await api.createKbBuilderSession({
        mode,
        knowledge_base_id: mode === "config" ? base?.id : undefined,
        schema_mode: mode === "config" && base?.schema_mode === "custom" ? "custom" : "default",
        runtime_id: selectedRuntime.id,
        model: draft.model.trim() || undefined,
      });
      if (session.session_id) onOpen(session.session_id, selectedRuntime.id);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? t(($) => $.builder.errors.forbidden)
          : err instanceof Error
            ? err.message
            : t(($) => $.builder.errors.create_failed),
      );
    } finally {
      setStarting(false);
    }
  };

  return (
    <BuilderSetup
      banner={banner}
      title={mode === "create" ? t(($) => $.builder.setup_create_title) : t(($) => $.builder.setup_config_title)}
      description={t(($) => $.builder.setup_description)}
      draft={draft}
      onChange={setDraft}
      runtimes={form.runtimes}
      runtimesLoading={form.runtimesLoading}
      members={form.members}
      currentUserId={form.currentUserId}
      selectedRuntime={selectedRuntime}
      starting={starting}
      error={error}
      onStart={() => void start()}
      connectRuntimeHref={paths.runtimes()}
    />
  );
}

/** Empty conversation: the builder's opening line and starters (1.2, 10.1). */
function KbBuilderIntro({
  mode,
  banner,
  onSend,
}: {
  mode: KbBuilderMode;
  banner: ReactNode;
  onSend: (content: string) => void;
}) {
  const { t } = useT("kb");

  return (
    <div className="flex flex-col gap-4 px-7 py-6">
      {banner}
      <p className="text-body leading-7">
        {mode === "create" ? t(($) => $.builder.intro_create) : t(($) => $.builder.intro_config)}
      </p>
      {mode === "create" ? (
        <>
          <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
            {CREATE_STARTERS.map((key) => {
              const title = t(($) => $.builder.starters[key].title);
              const description = t(($) => $.builder.starters[key].description);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onSend(t(($) => $.builder.starter_message, { title, description }))}
                  className="flex flex-col gap-0.5 rounded-xl bg-muted/60 px-3.5 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-body font-medium">{title}</span>
                  <span className="text-caption leading-5 text-faint-foreground">{description}</span>
                </button>
              );
            })}
          </div>
          <p className="text-caption text-faint-foreground">{t(($) => $.builder.describe_hint)}</p>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          {CONFIG_QUESTIONS.map((key) => {
            const question = t(($) => $.builder.questions[key]);
            return (
              <button
                key={key}
                type="button"
                onClick={() => onSend(question)}
                className="rounded-xl bg-muted/60 px-3.5 py-2.5 text-left text-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {question}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One builder conversation: the chat on the left, the live configuration on
 * the right. Mounted with `key={sessionId}`, so every piece of state belongs
 * to one conversation.
 */
function KbBuilderWorkspace({
  mode,
  kbSlug,
  sessionId,
  base,
  session,
  sessions,
  sessionsSettled,
  fallbackRuntimeId,
  onResume,
  onBack,
  onDiscarded,
  onMissing,
}: {
  mode: KbBuilderMode;
  kbSlug: string;
  sessionId: string;
  base: KnowledgeBaseDetail | undefined;
  session: KbBuilderSession | undefined;
  sessions: KbBuilderSession[];
  sessionsSettled: boolean;
  /** The runtime a just-started conversation runs on (not listed yet). */
  fallbackRuntimeId: string;
  onResume: (sessionId: string) => void;
  onBack: () => void;
  /** The member discarded the conversation. */
  onDiscarded: () => void;
  /** The conversation no longer exists (deleted elsewhere, stale link). */
  onMissing: () => void;
}) {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const templates = useQuery(kbTemplatesOptions());
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "marvis_kb_builder_layout" });

  const [draft, setDraft] = useState<KbDraft>(EMPTY_KB_DRAFT);
  const [justUpdated, setJustUpdated] = useState<ReadonlySet<KbDraftField>>(new Set());
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // The schema the member had typed in the custom mode, so a round trip
  // through the default mode does not lose it.
  const [customSchema, setCustomSchema] = useState<string | null>(null);
  const [boundRuntimeId, setBoundRuntimeId] = useState<string | null>(null);
  const runtimeId = boundRuntimeId ?? session?.runtime_id ?? fallbackRuntimeId;
  const runtime = runtimes.find((item) => item.id === runtimeId) ?? null;

  // The schema a default-mode form shows: the base's own while it is still in
  // the default mode, otherwise today's built-in template.
  const builtInSchema = templates.data?.default_schema ?? "";
  const defaultSchema = mode === "config" && base?.schema_mode === "default" ? base.schema : builtInSchema;
  const saved = useMemo(() => (base ? kbDraftFromBase(base) : null), [base]);

  const seed = useCallback(
    (): KbDraft => (mode === "config" && base ? kbDraftFromBase(base) : { ...EMPTY_KB_DRAFT, schema: builtInSchema }),
    [base, builtInSchema, mode],
  );
  const draftSync = useKbDraftSync({
    sessionId,
    stored: session?.draft,
    ready: sessionsSettled && templates.isSuccess && (mode === "create" || !!base),
    seed,
    defaultSchema,
    draft,
    setDraft,
  });

  // Read through a ref so the encoder always sees the current form.
  const encodeContext = useRef(draft);
  encodeContext.current = draft;
  const builder = useBuilderSession({
    sessionId,
    encodeInput: (text) => encodeKbBuilderInput(text, encodeContext.current),
    transport: KB_BUILDER_TRANSPORT,
  });

  // Apply the latest builder reply once it has settled, like the agent
  // builder: only after the restore, and only once per reply.
  const completed = !builder.pending && !builder.messagesLoading;
  const latestDraftMessage = [...builder.messages]
    .reverse()
    .find((message) => message.role === "assistant" && !message.failure_reason && parseKbDraft(message.content, { completed }));
  const latestDraftId = latestDraftMessage?.id;
  const latestDraftContent = latestDraftMessage?.content;
  const { restored, appliedMessageId, markApplied, cancelPending } = draftSync;
  useEffect(() => {
    if (!restored || !completed || !latestDraftId || !latestDraftContent) return;
    if (latestDraftId === appliedMessageId) return;
    const payload = parseKbDraft(latestDraftContent, { completed });
    if (!payload) return;

    markApplied(latestDraftId);
    setDraft((current) => {
      const next = mergeKbDraft(current, payload, mode);
      const changed = new Set<KbDraftField>();
      for (const field of ["name", "slug", "description", "purpose", "schema"] as const) {
        if (next[field] !== current[field]) changed.add(field);
      }
      setJustUpdated(changed);
      return next;
    });
  }, [appliedMessageId, completed, latestDraftContent, latestDraftId, markApplied, mode, restored]);

  const displayMessages = useMemo(
    () =>
      builder.messages.map((message) => ({
        ...message,
        content: message.role === "user" ? decodeKbBuilderInput(message.content) : stripKbDraft(message.content),
      })),
    [builder.messages],
  );

  const { missing } = builder;
  useEffect(() => {
    if (missing) onMissing();
  }, [missing, onMissing]);

  const handleChange = (patch: Partial<KbDraft>, field: KbDraftField) => {
    setDraft((current) => ({ ...current, ...patch }));
    if (field === "name") setNameError(null);
    setFormError(null);
    if (justUpdated.has(field)) {
      setJustUpdated((current) => new Set([...current].filter((item) => item !== field)));
    }
  };

  const handleSchemaModeChange = (schemaMode: KnowledgeBaseSchemaMode) => {
    if (draft.schemaMode === schemaMode) return;
    setFormError(null);
    if (schemaMode === "default") {
      setCustomSchema(draft.schema);
      setDraft({ ...draft, schemaMode, schema: defaultSchema });
      return;
    }
    // Custom starts from what the member had, else from the default text.
    setDraft({ ...draft, schemaMode, schema: customSchema ?? draft.schema });
  };

  const handleRuntimeSwitch = async (nextRuntimeId: string) => {
    if (!nextRuntimeId || nextRuntimeId === runtimeId) return;
    const bound = await builder.switchRuntime(nextRuntimeId);
    if (bound) setBoundRuntimeId(bound);
  };

  const createBase = useCreateKnowledgeBase();
  const updateBase = useUpdateKnowledgeBase();
  const submitting = createBase.isPending || updateBase.isPending;
  const slugError =
    mode === "create" && draft.slug.trim() && !isValidKbSlug(draft.slug.trim().toLowerCase())
      ? t(($) => $.builder.panel.slug_invalid)
      : null;

  // Creating finishes the conversation once the base exists: archive it so
  // it leaves the unfinished list. Best-effort, like the agent builder — the
  // write is already committed. A configuration save keeps the conversation
  // open; it drops out of the list because nothing is left unsaved.
  const retire = async () => {
    cancelPending();
    try {
      await api.setChatSessionArchived(sessionId, true);
    } catch {
      // The draft stays listed; the member can discard it explicitly.
    }
    void qc.invalidateQueries({ queryKey: kbKeys.builderSessions(wsId) });
  };

  const submit = async () => {
    if (!draft.name.trim()) {
      setNameError(t(($) => $.builder.errors.name_required));
      return;
    }
    setFormError(null);

    if (mode === "create") {
      const request = kbCreateRequest(draft);
      if (!request) return;
      try {
        const created = await createBase.mutateAsync(request);
        await retire();
        navigation.replace(`${paths.kbBase(created.slug || request.slug)}?welcome=1`);
      } catch (err) {
        setFormError(
          err instanceof ApiError && err.status === 409
            ? t(($) => $.builder.errors.slug_taken)
            : err instanceof Error
              ? err.message
              : t(($) => $.builder.errors.create_failed),
        );
      }
      return;
    }

    const request = kbUpdateRequest(draft, base?.updated_at ?? "");
    if (!request) return;
    try {
      await updateBase.mutateAsync({ kb: kbSlug, data: request });
      toast.success(t(($) => $.builder.saved));
      void qc.invalidateQueries({ queryKey: kbKeys.builderSessions(wsId) });
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status === 409
          ? t(($) => $.builder.errors.conflict)
          : err instanceof ApiError && err.status === 403
            ? t(($) => $.builder.errors.forbidden)
            : err instanceof Error
              ? err.message
              : t(($) => $.builder.errors.save_failed),
      );
    }
  };

  const discard = async () => {
    if (!(await builder.destroy())) return;
    setConfirmingDiscard(false);
    onDiscarded();
  };

  const dirty = mode === "config" && restored && !!saved && isKbDraftChanged(draft, saved);
  const canSubmit =
    restored &&
    !builder.pending &&
    !submitting &&
    !slugError &&
    (mode === "create" ? !!kbCreateRequest(draft) : !!kbUpdateRequest(draft, ""));
  const banner = (
    <KbDraftsBanner
      mode={mode}
      sessions={sessions.filter((row) => row.session_id !== sessionId)}
      onResume={onResume}
    />
  );

  return (
    <KbBuilderShell
      creating={mode === "create"}
      subtitle={mode === "create" ? t(($) => $.builder.create_sub) : (base?.name ?? kbSlug)}
      onBack={onBack}
      runtimeChip={
        <KbRuntimeChip
          runtimes={runtimes}
          currentUserId={currentUserId}
          runtimeId={runtimeId}
          disabled={builder.pending || builder.switchingRuntime || !sessionsSettled}
          onSwitch={(id) => void handleRuntimeSwitch(id)}
        />
      }
    >
      <ResizablePanelGroup
        orientation="horizontal"
        className="min-h-0 flex-1"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel id="conversation" minSize="30%">
          <BuilderConversation
            sessionId={sessionId}
            title={t(($) => $.builder.chat_title)}
            draftKey={`kb-builder:${sessionId}`}
            transformContent={stripKbDraft}
            emptyState={
              <KbBuilderIntro mode={mode} banner={banner} onSend={(content) => void builder.send(content)} />
            }
            messages={displayMessages}
            loading={builder.messagesLoading}
            pendingTask={builder.pendingTask}
            runtimeOnline={runtime?.status === "online"}
            onSend={builder.send}
            onStop={() => void builder.stop()}
            restoreDraftRequest={builder.restoreDraftRequest}
            onRestoreDraftApplied={builder.handleRestoreDraftApplied}
            error={builder.error}
          />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="config" defaultSize={520} minSize={360} groupResizeBehavior="preserve-pixel-size">
          <div className="flex h-full min-h-0 flex-col border-l bg-muted/10">
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <KbConfigPanel
                mode={mode}
                draft={draft}
                onChange={handleChange}
                onSchemaModeChange={handleSchemaModeChange}
                justUpdated={justUpdated}
                nameError={nameError}
                slugError={slugError}
              />
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2.5 border-t px-5 py-3">
              {formError ? (
                <p role="alert" className="mr-auto min-w-0 text-body text-destructive">
                  {formError}
                </p>
              ) : dirty ? (
                <span className="mr-auto text-caption text-faint-foreground">{t(($) => $.builder.footer.unsaved)}</span>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                disabled={submitting || builder.closing}
                onClick={() => setConfirmingDiscard(true)}
              >
                {mode === "create" ? t(($) => $.builder.footer.discard_create) : t(($) => $.builder.footer.discard_config)}
              </Button>
              <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                {mode === "create" ? t(($) => $.builder.footer.create) : t(($) => $.builder.footer.save)}
              </Button>
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      <AlertDialog
        open={confirmingDiscard}
        onOpenChange={(open) => {
          if (!open && !builder.closing) setConfirmingDiscard(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {mode === "create" ? t(($) => $.builder.discard.create_title) : t(($) => $.builder.discard.config_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.builder.discard.description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={builder.closing}>{t(($) => $.builder.discard.keep)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={builder.closing}
              onClick={(event) => {
                // Close only once the server accepted the delete.
                event.preventDefault();
                void discard();
              }}
            >
              {mode === "create" ? t(($) => $.builder.footer.discard_create) : t(($) => $.builder.footer.discard_config)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </KbBuilderShell>
  );
}

/**
 * Creating (/kb/new) and configuring (/kb/{slug}/config) a knowledge base
 * through the builder conversation. Without a session in the path it is the
 * runtime choice step; with one, the conversation and its configuration.
 */
export function KbBuilderPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const backOrReplace = useBackOrReplace();
  const { mode: routeMode, kbSlug, sessionId } = parseKbBuilderRoute(navigation.pathname);
  const mode: KbBuilderMode = routeMode ?? "create";
  const startedRuntimeId = navigation.searchParams.get("runtime") ?? "";

  const { data: base } = useQuery({ ...kbBaseDetailOptions(wsId, kbSlug), enabled: mode === "config" && !!wsId && !!kbSlug });
  const sessionsQuery = useQuery(kbBuilderSessionListOptions(wsId, mode, mode === "config" ? kbSlug : ""));
  const sessions = sessionsQuery.data ?? NO_SESSIONS;
  const sessionsSettled = sessionsQuery.isSuccess || sessionsQuery.isError;
  // Configuration conversations stay open after a save; only those still
  // holding unsaved changes count as unfinished.
  const unfinished = useMemo(
    () => (mode === "config" ? (base ? sessions.filter((row) => kbBuilderSessionHasUnsavedChanges(row, base)) : []) : sessions),
    [base, mode, sessions],
  );

  const homePath = mode === "create" ? paths.kb() : paths.kbBase(kbSlug);
  const setupPath = mode === "create" ? paths.kbNew() : paths.kbConfig(kbSlug);
  const sessionPath = useCallback(
    (id: string) => (mode === "create" ? paths.kbNewSession(id) : paths.kbConfigSession(kbSlug, id)),
    [kbSlug, mode, paths],
  );

  const open = useCallback(
    (id: string, runtimeId: string | null) =>
      navigation.replace(runtimeId ? `${sessionPath(id)}?runtime=${encodeURIComponent(runtimeId)}` : sessionPath(id)),
    [navigation, sessionPath],
  );
  const leaveSession = useCallback(() => navigation.replace(homePath), [homePath, navigation]);
  const leaveSetup = useCallback(() => navigation.replace(setupPath), [navigation, setupPath]);

  if (!sessionId) {
    return (
      <KbBuilderShell
        creating={mode === "create"}
        subtitle={mode === "create" ? t(($) => $.builder.create_sub) : (base?.name ?? kbSlug)}
        onBack={() => backOrReplace(homePath)}
      >
        <KbBuilderSetupStep mode={mode} base={base} sessions={unfinished} onOpen={open} />
      </KbBuilderShell>
    );
  }

  return (
    <KbBuilderWorkspace
      key={sessionId}
      mode={mode}
      kbSlug={kbSlug}
      sessionId={sessionId}
      base={base}
      session={sessions.find((row) => row.session_id === sessionId)}
      sessions={unfinished}
      sessionsSettled={sessionsSettled}
      fallbackRuntimeId={startedRuntimeId}
      onResume={(id) => open(id, null)}
      onBack={() => backOrReplace(homePath)}
      onDiscarded={leaveSession}
      onMissing={leaveSetup}
    />
  );
}
