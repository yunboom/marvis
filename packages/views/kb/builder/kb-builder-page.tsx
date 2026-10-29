"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDefaultLayout } from "react-resizable-panels";
import { Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@marvis/core/api";
import { useAuthStore } from "@marvis/core/auth";
import { useWorkspaceId } from "@marvis/core/hooks";
import {
  EMPTY_KB_DRAFT,
  decodeKbBuilderInput,
  encodeKbBuilderInput,
  isKbBuilderRuntimeReady,
  isKbDraftChanged,
  isValidKbSlug,
  kbBaseDetailOptions,
  kbBuilderRuntimeKey,
  kbBuilderSessionHasUnsavedChanges,
  kbBuilderSessionListOptions,
  kbCreateRequest,
  kbDraftFromBase,
  kbKeys,
  kbTemplatesOptions,
  kbUpdateRequest,
  mergeKbDraft,
  parseKbDraft,
  pickKbBuilderRuntime,
  stripKbDraft,
  useCreateKnowledgeBase,
  useKbBuilderRuntimeStore,
  useUpdateKnowledgeBase,
  type KbDraft,
} from "@marvis/core/kb";
import { useWorkspacePaths } from "@marvis/core/paths";
import { runtimeDisplayLabel, runtimeListOptions } from "@marvis/core/runtimes";
import type {
  KbBuilderMode,
  KbBuilderSession,
  KnowledgeBaseDetail,
  KnowledgeBaseSchemaMode,
  RuntimeDevice,
} from "@marvis/core/types";
import { memberListOptions } from "@marvis/core/workspace/queries";
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
import { cn } from "@marvis/ui/lib/utils";
import { BuilderConversation } from "../../agents/create/builder-conversation";
import { UnfinishedDraftsBanner } from "../../agents/create/unfinished-drafts";
import { useBuilderSession, type BuilderSessionTransport } from "../../agents/create/use-builder-session";
import { AppLink, useBackOrReplace, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { KbConfigPanel, type KbDraftField } from "./kb-config-panel";
import { parseKbBuilderRoute } from "./kb-builder-route";
import { KbBuilderPaneTabs, KbBuilderShell } from "./kb-builder-shell";
import { KbRuntimeControls } from "./kb-runtime-controls";
import { useKbDraftSync } from "./use-kb-draft-sync";

const KB_BUILDER_TRANSPORT: BuilderSessionTransport = {
  listKey: (wsId) => kbKeys.builderSessions(wsId),
  switchRuntime: (sessionId, runtimeId) => api.switchKbBuilderRuntime(sessionId, { runtime_id: runtimeId }),
  destroy: (sessionId) => api.deleteKbBuilderSession(sessionId),
};

const NO_SESSIONS: KbBuilderSession[] = [];
const NO_RUNTIMES: RuntimeDevice[] = [];

/** Starter directions of a new knowledge base (design 1.2). */
const CREATE_STARTERS = ["dev", "qa", "product", "team", "agent_team", "other"] as const;
/** Opening questions of a configuration (design 10.1). */
const CONFIG_QUESTIONS = ["readers", "scope", "structure", "writing"] as const;

/** Below this width of the builder area, chat and configuration become tabs (matches `@2xl`). */
const NARROW_BUILDER_WIDTH = 672;

type BuilderPane = "chat" | "config";

/** The first message while its conversation is being started. */
interface PendingStart {
  text: string;
  status: "starting" | "failed";
  /** Why the start failed, when it is not the usual offline/forbidden race. */
  reason: string | null;
}

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
      className="mb-0"
      bannerLabel={
        mode === "create"
          ? t(($) => $.builder.drafts_create, { count: sessions.length })
          : t(($) => $.builder.drafts_config, { count: sessions.length })
      }
      bannerHint={t(($) => $.builder.drafts_hint)}
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
 * Empty conversation: the drafts entry, the builder's opening line and its
 * starters (1.2, 10.1); then the first message while its conversation starts.
 */
function KbBuilderIntro({
  mode,
  banner,
  pendingStart,
  runtimeName,
  disabled,
  onSend,
}: {
  mode: KbBuilderMode;
  banner: ReactNode;
  pendingStart: PendingStart | null;
  runtimeName: string;
  /** No runtime can answer, so the starters cannot be sent. */
  disabled: boolean;
  onSend: (content: string) => void;
}) {
  const { t } = useT("kb");
  const starterClass =
    "rounded-xl bg-muted/60 px-3.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4 px-7 py-6 @max-md:px-4">
      {banner}
      <p className="text-body leading-7">
        {mode === "create" ? t(($) => $.builder.intro_create) : t(($) => $.builder.intro_config)}
      </p>
      {pendingStart ? (
        <>
          <div className="max-w-[78%] self-end rounded-2xl bg-muted px-3.5 py-2.5 text-body whitespace-pre-wrap">
            {pendingStart.text}
          </div>
          {pendingStart.status === "starting" && (
            <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground">
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t(($) => $.builder.starting, { runtime: runtimeName })}
            </p>
          )}
        </>
      ) : mode === "create" ? (
        <>
          <div className="grid grid-cols-2 gap-2 @max-md:grid-cols-1">
            {CREATE_STARTERS.map((key) => {
              const title = t(($) => $.builder.starters[key].title);
              const description = t(($) => $.builder.starters[key].description);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  onClick={() => onSend(t(($) => $.builder.starters[key].message))}
                  className={cn("flex flex-col gap-0.5 py-3", starterClass)}
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
                disabled={disabled}
                onClick={() => onSend(question)}
                className={cn("py-2.5 text-body", starterClass)}
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

/** Why the composer is off and what to do about it (design notices). */
function KbBuilderNotice({
  tone,
  title,
  body,
  action,
}: {
  tone: "neutral" | "warning";
  title: string;
  body: string;
  action: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-3 rounded-xl px-4 py-3.5 @max-md:flex-col @max-md:items-stretch",
        tone === "warning" ? "bg-warning/12" : "bg-muted",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body font-medium">{title}</span>
        <span className="text-caption text-muted-foreground">{body}</span>
      </div>
      {action}
    </div>
  );
}

/** The live width of an element inside its borders; 0 until it is measured. */
function useElementWidth<E extends HTMLElement>() {
  const [element, setElement] = useState<E | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);

    return () => observer.disconnect();
  }, [element]);

  return { ref: setElement, width };
}

/**
 * The builder: the conversation on the left, the configuration on the right,
 * and the runtime in the header. The conversation starts with the first
 * message; until then the runtime is only a selection. The configuration
 * never needs a runtime, so it can be filled in and created without one.
 *
 * Mounted with a key per conversation, except that a conversation started
 * here keeps the instance it was started from.
 */
function KbBuilderWorkspace({
  mode,
  kbSlug,
  routeSessionId,
  base,
  sessions,
  unfinished,
  sessionsSettled,
  fallbackRuntimeId,
  onStarted,
  onResume,
  onBack,
  onDiscarded,
  onMissing,
}: {
  mode: KbBuilderMode;
  kbSlug: string;
  /** The conversation named by the URL; empty before one is started. */
  routeSessionId: string;
  base: KnowledgeBaseDetail | undefined;
  sessions: KbBuilderSession[];
  /** The unfinished conversations offered at the top of the chat. */
  unfinished: KbBuilderSession[];
  sessionsSettled: boolean;
  /** The runtime a just-started conversation runs on (not listed yet). */
  fallbackRuntimeId: string;
  /** A conversation was started here on its first message. */
  onStarted: (sessionId: string, runtimeId: string) => void;
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
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const runtimes = runtimesQuery.data ?? NO_RUNTIMES;
  const runtimesSettled = runtimesQuery.isSuccess || runtimesQuery.isError;
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const templates = useQuery(kbTemplatesOptions());
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "marvis_kb_builder_layout" });
  const { ref: bodyRef, width: bodyWidth } = useElementWidth<HTMLDivElement>();
  const narrow = bodyWidth > 0 && bodyWidth < NARROW_BUILDER_WIDTH;
  const [pane, setPane] = useState<BuilderPane>("chat");

  const lastRuntimeId = useKbBuilderRuntimeStore((state) =>
    currentUserId ? state.byKey[kbBuilderRuntimeKey(wsId, currentUserId)] : undefined,
  );
  const setLastRuntime = useKbBuilderRuntimeStore((state) => state.setLastRuntime);

  const [createdSessionId, setCreatedSessionId] = useState("");
  const sessionId = routeSessionId || createdSessionId;
  const session = sessions.find((row) => row.session_id === sessionId);

  const [draft, setDraft] = useState<KbDraft>(EMPTY_KB_DRAFT);
  const [justUpdated, setJustUpdated] = useState<ReadonlySet<KbDraftField>>(new Set());
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // The schema the member had typed in the custom mode, so a round trip
  // through the default mode does not lose it.
  const [customSchema, setCustomSchema] = useState<string | null>(null);
  const [runtimeMenuOpen, setRuntimeMenuOpen] = useState(false);
  const [pendingStart, setPendingStart] = useState<PendingStart | null>(null);

  // Before a conversation exists the runtime is only a selection: the
  // member's pick, else the default. Afterwards it is what the conversation
  // is bound to.
  const [pickedRuntimeId, setPickedRuntimeId] = useState<string | null>(null);
  const [model, setModel] = useState("");
  const [startedRuntimeId, setStartedRuntimeId] = useState<string | null>(null);
  const [boundRuntimeId, setBoundRuntimeId] = useState<string | null>(null);
  const defaultRuntime = useMemo(
    () => pickKbBuilderRuntime(runtimes, currentUserId, lastRuntimeId),
    [currentUserId, lastRuntimeId, runtimes],
  );
  const runtimeId = sessionId
    ? (boundRuntimeId ?? session?.runtime_id ?? startedRuntimeId ?? fallbackRuntimeId)
    : (pickedRuntimeId ?? defaultRuntime?.runtime.id ?? "");
  const runtime = runtimes.find((item) => item.id === runtimeId) ?? null;
  const runtimeOnline = !!runtime && isKbBuilderRuntimeReady(runtime, currentUserId);
  const noRuntime = runtimesSettled && !runtime && !defaultRuntime;

  // The schema a default-mode form shows: the base's own while it is still in
  // the default mode, otherwise today's built-in template.
  const builtInSchema = templates.data?.default_schema ?? "";
  const defaultSchema = mode === "config" && base?.schema_mode === "default" ? base.schema : builtInSchema;
  const saved = useMemo(() => (base ? kbDraftFromBase(base) : null), [base]);

  const seed = useCallback(
    // A new knowledge base starts on an empty custom schema; the built-in one
    // shows as the field's example.
    (): KbDraft => (mode === "config" && base ? kbDraftFromBase(base) : { ...EMPTY_KB_DRAFT, schemaMode: "custom" }),
    [base, mode],
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

  // Creating archives the conversation and discarding deletes it, so it goes
  // missing right as we leave; only a conversation lost while still open
  // sends the member back to a fresh page.
  const leavingRef = useRef(false);
  const { missing } = builder;
  useEffect(() => {
    if (missing && !leavingRef.current) onMissing();
  }, [missing, onMissing]);

  /**
   * Starts the conversation on `startRuntimeId` and sends its first message.
   * A failed start keeps the message so a runtime change can resend it.
   */
  const startAndSend = async (text: string, startRuntimeId: string): Promise<boolean> => {
    const target = runtimes.find((item) => item.id === startRuntimeId);
    if (!target || !isKbBuilderRuntimeReady(target, currentUserId)) return false;
    if (mode === "config" && !base?.id) return false;

    setPendingStart({ text, status: "starting", reason: null });
    let startedId: string;
    try {
      const started = await api.createKbBuilderSession({
        mode,
        knowledge_base_id: mode === "config" ? base?.id : undefined,
        // A new knowledge base starts on a custom schema the builder drafts.
        schema_mode: mode === "create" || base?.schema_mode === "custom" ? "custom" : "default",
        runtime_id: target.id,
        model: model.trim() || undefined,
      });
      // Without an id there is nothing to address; the notice's own copy applies.
      if (!started.session_id) throw new Error("");
      startedId = started.session_id;
    } catch (err) {
      // An offline race (409) or a runtime that is not ours to use (403) is
      // what the notice already explains; anything else says what happened.
      const expected = err instanceof ApiError && (err.status === 409 || err.status === 403);
      setPendingStart({
        text,
        status: "failed",
        reason: !expected && err instanceof Error && err.message ? err.message : null,
      });
      return false;
    }

    if (currentUserId) setLastRuntime(wsId, currentUserId, target.id);
    setStartedRuntimeId(target.id);
    setCreatedSessionId(startedId);
    onStarted(startedId, target.id);
    const sent = await builder.send(text, undefined, startedId);
    setPendingStart(null);

    return sent;
  };

  const send = async (content: string, commitInput?: () => void): Promise<boolean> => {
    if (sessionId) return builder.send(content, commitInput);

    const text = content.trim();
    if (!text || pendingStart?.status === "starting" || !runtimeOnline) return false;

    // The message shows above while its conversation starts, so the composer
    // lets go of it now.
    commitInput?.();

    return startAndSend(text, runtimeId);
  };

  const handleRuntimeSelect = async (nextRuntimeId: string) => {
    if (!nextRuntimeId || nextRuntimeId === runtimeId) return;

    if (!sessionId) {
      setPickedRuntimeId(nextRuntimeId);
      setModel("");
      // A start that failed on the old runtime is retried on the new one.
      if (pendingStart?.status === "failed") void startAndSend(pendingStart.text, nextRuntimeId);
      return;
    }

    const bound = await builder.switchRuntime(nextRuntimeId);
    if (!bound) return;

    setBoundRuntimeId(bound);
    if (currentUserId) setLastRuntime(wsId, currentUserId, bound);
  };

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

  const createBase = useCreateKnowledgeBase();
  const updateBase = useUpdateKnowledgeBase();
  const submitting = createBase.isPending || updateBase.isPending;
  const starting = pendingStart?.status === "starting";
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
    if (!sessionId) return;
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
        leavingRef.current = true;
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
    leavingRef.current = true;
    if (!(await builder.destroy())) {
      leavingRef.current = false;
      return;
    }
    setConfirmingDiscard(false);
    onDiscarded();
  };

  const dirty = mode === "config" && restored && !!saved && isKbDraftChanged(draft, saved);
  const canSubmit =
    restored &&
    !builder.pending &&
    !starting &&
    !submitting &&
    !slugError &&
    (mode === "create" ? !!kbCreateRequest(draft) : !!kbUpdateRequest(draft, ""));
  const runtimeBusy = builder.pending || builder.switchingRuntime || starting || (!!sessionId && !sessionsSettled);
  const composerEnabled = runtimeOnline && !starting;
  const showManualHint = runtimesSettled && (noRuntime || !runtimeOnline);

  const openRuntimeMenu = () => setRuntimeMenuOpen(true);
  const changeRuntimeAction = (
    <Button type="button" size="sm" className="shrink-0" onClick={openRuntimeMenu}>
      {t(($) => $.builder.notice.change)}
    </Button>
  );
  let notice: ReactNode = null;
  if (pendingStart?.status === "failed") {
    notice = (
      <KbBuilderNotice
        tone="warning"
        title={t(($) => $.builder.notice.failed_title)}
        body={pendingStart.reason ?? t(($) => $.builder.notice.failed_body)}
        action={changeRuntimeAction}
      />
    );
  } else if (noRuntime) {
    notice = (
      <KbBuilderNotice
        tone="neutral"
        title={t(($) => $.builder.notice.none_title)}
        body={mode === "create" ? t(($) => $.builder.notice.none_body_create) : t(($) => $.builder.notice.none_body_config)}
        action={
          <Button
            size="sm"
            className="shrink-0"
            render={<AppLink href={paths.runtimes()} />}
            nativeButton={false}
          >
            {t(($) => $.builder.notice.connect)}
          </Button>
        }
      />
    );
  } else if (runtimesSettled && !runtimeOnline) {
    notice =
      sessionId && builder.messages.length > 0 ? (
        <KbBuilderNotice
          tone="warning"
          title={t(($) => $.builder.notice.went_offline_title)}
          body={t(($) => $.builder.notice.went_offline_body)}
          action={changeRuntimeAction}
        />
      ) : (
        <KbBuilderNotice
          tone="neutral"
          title={t(($) => $.builder.notice.offline_title, {
            name: runtime ? runtimeDisplayLabel(runtime) : t(($) => $.builder.runtime.label),
          })}
          body={t(($) => $.builder.notice.offline_body, { host: runtime?.device_info ?? "" })}
          action={changeRuntimeAction}
        />
      );
  }

  const banner = (
    <KbDraftsBanner
      mode={mode}
      sessions={unfinished.filter((row) => row.session_id !== sessionId)}
      onResume={onResume}
    />
  );

  const runtimeControls = (
    <KbRuntimeControls
      runtimes={runtimes}
      members={members}
      currentUserId={currentUserId}
      runtimeId={runtimeId}
      lastUsedId={lastRuntimeId}
      runtimeDisabled={runtimeBusy}
      menuOpen={runtimeMenuOpen}
      onMenuOpenChange={setRuntimeMenuOpen}
      onRuntimeSelect={(id) => void handleRuntimeSelect(id)}
      connectHref={paths.runtimes()}
      // The model is frozen onto the conversation when it starts, so it
      // is chosen only before that, as on the old runtime step.
      model={sessionId ? undefined : { value: model, onChange: setModel, disabled: !runtime || starting }}
    />
  );

  const conversation = (
    <BuilderConversation
      sessionId={sessionId}
      showHeader={false}
      title={t(($) => $.builder.chat_title)}
      draftKey={`kb-builder:${sessionId || `new:${mode}:${kbSlug}`}`}
      transformContent={stripKbDraft}
      emptyState={
        <KbBuilderIntro
          mode={mode}
          banner={banner}
          pendingStart={pendingStart}
          runtimeName={runtime ? runtimeDisplayLabel(runtime) : ""}
          disabled={!composerEnabled}
          onSend={(content) => void send(content)}
        />
      }
      messages={displayMessages}
      loading={builder.messagesLoading}
      pendingTask={builder.pendingTask}
      runtimeOnline={composerEnabled}
      notice={notice}
      composerToolbar={runtimeControls}
      disabledPlaceholder={
        starting
          ? undefined
          : noRuntime
            ? t(($) => $.builder.composer.none)
            : t(($) => $.builder.composer.offline)
      }
      onSend={send}
      onStop={() => void builder.stop()}
      restoreDraftRequest={builder.restoreDraftRequest}
      onRestoreDraftApplied={builder.handleRestoreDraftApplied}
      error={builder.error}
    />
  );

  const configuration = (
    <div className="flex h-full min-h-0 flex-col border-l bg-muted/10">
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <KbConfigPanel
          mode={mode}
          draft={draft}
          onChange={handleChange}
          onSchemaModeChange={handleSchemaModeChange}
          schemaExample={builtInSchema}
          justUpdated={justUpdated}
          nameError={nameError}
          slugError={slugError}
        />
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2.5 border-t py-3 pr-20 pl-5">
        {formError ? (
          <p role="alert" className="mr-auto min-w-0 text-body text-destructive">
            {formError}
          </p>
        ) : dirty ? (
          <span className="mr-auto text-caption text-faint-foreground">{t(($) => $.builder.footer.unsaved)}</span>
        ) : showManualHint ? (
          <span className="mr-auto min-w-0 text-caption text-faint-foreground">
            {mode === "create" ? t(($) => $.builder.manual_hint_create) : t(($) => $.builder.manual_hint_config)}
          </span>
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
  );

  return (
    <KbBuilderShell
      creating={mode === "create"}
      subtitle={mode === "create" ? t(($) => $.builder.create_sub) : (base?.name ?? kbSlug)}
      onBack={onBack}
    >
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col">
        {narrow ? (
          <>
            <KbBuilderPaneTabs pane={pane} onChange={setPane} />
            {/* Narrow, the composer spans the full width and its send button
                would sit under the chat launcher, so the chat pane reserves
                the launcher's corner below it. The configuration footer
                already keeps its buttons clear of the corner. */}
            <div
              role="tabpanel"
              aria-label={pane === "chat" ? t(($) => $.builder.tabs.chat) : t(($) => $.builder.tabs.config)}
              className={cn("flex min-h-0 flex-1 flex-col", pane === "chat" && "pb-chat-launcher")}
            >
              {pane === "chat" ? conversation : configuration}
            </div>
          </>
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            defaultLayout={defaultLayout}
            onLayoutChanged={onLayoutChanged}
          >
            <ResizablePanel id="conversation" minSize="30%">
              {conversation}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="config" defaultSize={520} minSize={360} groupResizeBehavior="preserve-pixel-size">
              {configuration}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>

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
 * Whether this member may configure the base: its creator or a workspace
 * owner or admin. Undefined while the answer is still loading. The server
 * enforces the same rule on every write.
 */
function useKbConfigureAccess(base: KnowledgeBaseDetail | undefined): boolean | undefined {
  const wsId = useWorkspaceId();
  const userId = useAuthStore((state) => state.user?.id ?? "");
  const membersQuery = useQuery(memberListOptions(wsId));

  if (!base || !userId || !membersQuery.isSuccess) return undefined;

  const role = membersQuery.data.find((member) => member.user_id === userId)?.role;

  return base.created_by === userId || role === "owner" || role === "admin";
}

/** A configuration this member may not change (design: forbidden). */
function KbConfigForbidden({ onBack }: { onBack: () => void }) {
  const { t } = useT("kb");

  return (
    <main className="grid min-h-0 flex-1 place-items-center bg-background p-6">
      <div className="flex max-w-md flex-col items-center gap-2.5 text-center">
        <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Lock className="size-5" />
        </span>
        <h1 className="text-title-sm font-semibold">{t(($) => $.builder.forbidden.title)}</h1>
        <p className="text-body text-muted-foreground">{t(($) => $.builder.forbidden.body)}</p>
        <Button type="button" variant="secondary" className="mt-1.5" onClick={onBack}>
          {t(($) => $.builder.forbidden.back)}
        </Button>
      </div>
    </main>
  );
}

/**
 * Creating (/kb/new) and configuring (/kb/{slug}/config) a knowledge base
 * through the builder conversation. The page opens straight on the builder;
 * a session in the path is a conversation already started.
 */
export function KbBuilderPage() {
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const backOrReplace = useBackOrReplace();
  const { mode: routeMode, kbSlug, sessionId } = parseKbBuilderRoute(navigation.pathname);
  const mode: KbBuilderMode = routeMode ?? "create";
  const startedRuntimeId = navigation.searchParams.get("runtime") ?? "";

  const { data: base } = useQuery({ ...kbBaseDetailOptions(wsId, kbSlug), enabled: mode === "config" && !!wsId && !!kbSlug });
  const canConfigure = useKbConfigureAccess(base);
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
  const freshPath = mode === "create" ? paths.kbNew() : paths.kbConfig(kbSlug);
  const sessionPath = useCallback(
    (id: string) => (mode === "create" ? paths.kbNewSession(id) : paths.kbConfigSession(kbSlug, id)),
    [kbSlug, mode, paths],
  );

  // A conversation started on this page keeps the instance it started from,
  // so the first message and the form survive the URL change; any other
  // conversation mounts its own.
  const [fresh, setFresh] = useState({ generation: 0, adoptedId: "" });
  const workspaceKey = sessionId && sessionId !== fresh.adoptedId ? sessionId : `new-${fresh.generation}`;

  const started = useCallback(
    (id: string, runtimeId: string) => {
      setFresh((current) => ({ ...current, adoptedId: id }));
      navigation.replace(`${sessionPath(id)}?runtime=${encodeURIComponent(runtimeId)}`);
    },
    [navigation, sessionPath],
  );
  const resume = useCallback((id: string) => navigation.replace(sessionPath(id)), [navigation, sessionPath]);
  const leaveSession = useCallback(() => navigation.replace(homePath), [homePath, navigation]);
  const restart = useCallback(() => {
    setFresh((current) => ({ generation: current.generation + 1, adoptedId: "" }));
    navigation.replace(freshPath);
  }, [freshPath, navigation]);

  if (mode === "config" && canConfigure === false) {
    return <KbConfigForbidden onBack={() => backOrReplace(homePath)} />;
  }

  return (
    <KbBuilderWorkspace
      key={workspaceKey}
      mode={mode}
      kbSlug={kbSlug}
      routeSessionId={sessionId}
      base={base}
      sessions={sessions}
      unfinished={unfinished}
      sessionsSettled={sessionsSettled}
      fallbackRuntimeId={startedRuntimeId}
      onStarted={started}
      onResume={resume}
      onBack={() => backOrReplace(homePath)}
      onDiscarded={leaveSession}
      onMissing={restart}
    />
  );
}
