"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownRight,
  FolderKanban,
  GripVertical,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  ToggleRight,
  Trash2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError, clientErrorMessage } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useCurrentWorkspace } from "@marvis/core/paths";
import { useIssueStatuses } from "@marvis/core/issue-statuses/hooks";
import { statusColumnKeys } from "@marvis/core/issues";
import {
  isFixedWorkflowStatus,
  statusAcceptsHandoff,
  useCreateIssueWorkflow,
  useDeleteIssueWorkflow,
  useIssueWorkflows,
  useUpdateIssueWorkflow,
  workflowMiddleKeys,
  workflowNextStatus,
} from "@marvis/core/issue-workflows";
import { useActorName } from "@marvis/core/workspace/hooks";
import { projectListOptions } from "@marvis/core/projects/queries";
import type {
  IssueWorkflow,
  IssueWorkflowMappingPlan,
  IssueWorkflowStep,
  IssueWorkflowStepInput,
} from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@marvis/ui/components/ui/dropdown-menu";
import { Spinner } from "@marvis/ui/components/ui/spinner";
import { Switch } from "@marvis/ui/components/ui/switch";
import { cn } from "@marvis/ui/lib/utils";
import { PickerItem, PickerSection, PropertyPicker } from "../issues/components/pickers/property-picker";
import { StatusIcon } from "../issues/components/status-icon";
import { useStatusLabel } from "../issues/utils/status-label";
import { ActorAvatar } from "../common/actor-avatar";
import { useT } from "../i18n";
import { BriefPreviewDialog, HandoffFields, savedHandoff } from "./handoff-form";
import { stepHandlerActor, useStepHandlerLabel } from "./step-handler";
import { WORKFLOW_TEMPLATES, type WorkflowTemplateId } from "./templates";
import { WorkflowMappingDialog } from "./workflow-mapping-dialog";

/**
 * The name and description edit in place. A hover or focus background tells
 * them apart from the read-only note under them.
 */
const INLINE_FIELD =
  "-mx-1.5 block w-[calc(100%+0.75rem)] rounded-md bg-transparent pl-1.5 pr-8 outline-none transition-colors placeholder:text-muted-foreground read-only:cursor-default hover:[&:not(:read-only)]:bg-accent/60 focus-visible:[&:not(:read-only)]:bg-accent/60 focus-visible:[&:not(:read-only)]:ring-1 focus-visible:[&:not(:read-only)]:ring-ring/40";

/** 编辑器铺满工作流页：顶部 60px 页头带下描边，下方左右两栏。 */
const EDITOR_BLEED = "flex min-h-full flex-col";

/** 编辑器页头：面包屑在左，操作在右。 */
const EDITOR_HEADER = "flex h-15 shrink-0 items-center gap-2 border-b border-surface-border pl-7 pr-5";

/** 步骤卡片的外形，新建状态的输入行沿用同一高度和圆角。 */
const STEP_SHAPE = "flex h-12.5 items-center gap-2 rounded-xl border-[1.5px] pl-2 pr-3";

/** Fixed statuses every workflow keeps; backlog and blocked can be switched off. */
const LOCKED_STATUSES = ["todo", "done", "cancelled"] as const;
type LockedStatus = (typeof LOCKED_STATUSES)[number];
type OptionalStatus = "backlog" | "blocked";

function isLocked(key: string | null): key is LockedStatus {
  return (LOCKED_STATUSES as readonly string[]).includes(key ?? "");
}

/** How the editor treats a step: kept, optional, or arranged in the middle. */
type StepKind = "locked" | "optional" | "middle" | "new";

/** A new workflow starts from the common delivery loop instead of nothing. */
const NEW_WORKFLOW_MIDDLE = ["in_progress", "in_review"];

/** A middle column of the draft: a library status, or one to create on save. */
type DraftColumn =
  | { id: string; status_key: string }
  | { id: string; new_name: string; category?: "unstarted" | "started"; status_group?: NewStatusGroup };

/** The board group a new started status can take; the server defaults to working. */
type NewStatusGroup = "working" | "needs_attention";

const NEW_STATUS_GROUPS: readonly NewStatusGroup[] = ["working", "needs_attention"];

/** What entering a column does, keyed in the draft by column id. */
type Handoff = Pick<IssueWorkflowStep, "handler" | "instructions" | "next_status_key" | "back_status_key">;

const NO_HANDOFF: Handoff = { handler: { type: "none" }, instructions: "" };

interface Draft {
  name: string;
  description: string;
  backlog: boolean;
  blocked: boolean;
  middle: DraftColumn[];
  handoffs: Record<string, Handoff>;
}

/**
 * The key a column goes by in the editor: its status, or — for a status the
 * save creates — its draft id, so its handoff can be edited before the save.
 */
function columnKey(column: DraftColumn): string {
  return "status_key" in column ? column.status_key : column.id;
}

function hasHandoff(h: Handoff | undefined): h is Handoff {
  return !!h && (h.handler.type !== "none" || !!h.next_status_key || !!h.back_status_key);
}

function draftFrom(workflow: Pick<IssueWorkflow, "name" | "description" | "steps">): Draft {
  const keys = workflow.steps.map((s) => s.status_key);
  const handoffs: Record<string, Handoff> = {};
  for (const s of workflow.steps) {
    const h = { handler: s.handler, instructions: s.instructions, next_status_key: s.next_status_key, back_status_key: s.back_status_key };
    if (hasHandoff(h)) handoffs[s.status_key] = h;
  }
  return {
    name: workflow.name,
    description: workflow.description,
    backlog: keys.includes("backlog"),
    blocked: keys.includes("blocked"),
    middle: workflowMiddleKeys(workflow).map((key) => ({ id: key, status_key: key })),
    handoffs,
  };
}

/** Every column of the draft in board order. */
function draftColumns(draft: Draft): DraftColumn[] {
  const fixed = (key: string): DraftColumn => ({ id: key, status_key: key });
  return [
    ...(draft.backlog ? [fixed("backlog")] : []),
    fixed("todo"),
    ...draft.middle,
    ...(draft.blocked ? [fixed("blocked")] : []),
    fixed("done"),
    fixed("cancelled"),
  ];
}

function sameDraft(a: Draft, b: Draft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mappingPlanFrom(err: unknown): IssueWorkflowMappingPlan | null {
  if (!(err instanceof ApiError) || err.status !== 409 || !err.body || typeof err.body !== "object") return null;
  const body = err.body as { code?: unknown; plan?: IssueWorkflowMappingPlan };
  if (body.code !== "workflow_status_mapping_required" || !body.plan) return null;
  return { ...body.plan, unchanged: body.plan.unchanged ?? [] };
}

/**
 * The workflow editor (MUL-7420): a workflow is a whole pipeline — its
 * columns and who each one hands an issue to. Todo, done and cancelled are
 * always there; backlog and blocked can be switched off; the editor arranges
 * what sits between. Selecting a column edits its handoff.
 *
 * `workflowId` is null for a new workflow; `seed` pre-fills one (duplicate).
 */
export function WorkflowEditorPage({
  workflowId,
  seed,
  template,
  canEdit,
  canDuplicate = canEdit,
  canCreateStatus = canEdit,
  onBack,
  onOpen,
}: {
  workflowId: string | null;
  seed: IssueWorkflow | null;
  /** Pre-fills a new workflow from a template. */
  template?: WorkflowTemplateId | null;
  canEdit: boolean;
  /** Duplicating creates a workflow, which any member may do. */
  canDuplicate?: boolean;
  /**
   * Whether saving may add statuses to the workspace catalog: statuses are
   * shared by every board, so only admins create them (MUL-8120).
   */
  canCreateStatus?: boolean;
  onBack: () => void;
  /** Navigates to another workflow's editor (after create, or to a duplicate). */
  onOpen: (target: { id: string } | { duplicateOf: string }) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const { workflows, isLoaded } = useIssueWorkflows(wsId);
  const { data: projects = [] } = useQuery(projectListOptions(wsId));
  const createWorkflow = useCreateIssueWorkflow();
  const updateWorkflow = useUpdateIssueWorkflow();
  const deleteWorkflow = useDeleteIssueWorkflow();

  const saved = workflowId ? workflows.find((w) => w.id === workflowId) ?? null : null;
  const isDefault = !!saved?.is_default;
  const baseline = useMemo<Draft>(() => {
    if (saved) return draftFrom(saved);
    if (seed) return { ...draftFrom(seed), name: t(($) => $.workflows.editor.copy_name, { name: seed.name }) };
    const tpl = template ? WORKFLOW_TEMPLATES.find((x) => x.id === template) : undefined;
    if (tpl) {
      const statusName = (name: string) =>
        t(($) => ($.workflows.templates[tpl.id].statuses as Record<string, string>)[name] ?? name);
      return {
        name: t(($) => $.workflows.templates[tpl.id].name),
        description: t(($) => $.workflows.templates[tpl.id].summary),
        backlog: true,
        blocked: true,
        handoffs: {},
        middle: tpl.columns.map((column): DraftColumn => {
          if ("status" in column) return { id: column.status, status_key: column.status };
          const name = statusName(column.name);
          const existing = catalog.activeStatuses.find((e) => e.name.toLowerCase() === name.toLowerCase());
          return existing
            ? { id: existing.key, status_key: existing.key }
            : { id: `new:${name}`, new_name: name, category: column.category, status_group: column.status_group };
        }),
      };
    }
    return {
      name: "",
      description: "",
      backlog: true,
      blocked: true,
      middle: NEW_WORKFLOW_MIDDLE.map((key) => ({ id: key, status_key: key })),
      handoffs: {},
    };
    // Re-seed only when the target changes or the saved row is refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved?.updated_at, workflowId, seed?.id, template, catalog.activeStatuses.length]);

  const [draft, setDraft] = useState<Draft>(baseline);
  const [mappingPlan, setMappingPlan] = useState<IssueWorkflowMappingPlan | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => setDraft(baseline), [baseline]);

  const dirty = !workflowId || !sameDraft(draft, baseline);
  const pending = createWorkflow.isPending || updateWorkflow.isPending;
  // Statuses this save would create; a member must drop them or ask an admin.
  const missingStatuses = canCreateStatus
    ? []
    : draft.middle.flatMap((c) => ("new_name" in c ? [c.new_name] : []));
  const canSave = canEdit && dirty && draft.name.trim().length > 0 && !pending && missingStatuses.length === 0;
  const usedBy = saved
    ? projects.filter((p) => (saved.is_default ? !p.workflow_id : saved.project_ids.includes(p.id)))
    : [];
  const columns = draftColumns(draft);
  const middleKeys = draft.middle.flatMap((c) => ("status_key" in c ? [c.status_key] : []));
  const addable = statusColumnKeys(catalog).filter((key) => !isFixedWorkflowStatus(key) && !middleKeys.includes(key));
  const ids = draft.middle.map((c) => c.id);
  const targetKeys = columns.flatMap((c) => ("status_key" in c ? [c.status_key] : []));
  // Next and back can only name statuses that exist before the save.
  const flow = { steps: targetKeys.map((status_key) => ({ status_key, ...NO_HANDOFF })) };
  // The default next follows the whole draft, unsaved columns included —
  // the order the server resolves it in once the draft is saved.
  const draftFlow = { steps: columns.map((c) => ({ status_key: columnKey(c), ...NO_HANDOFF })) };
  const columnLabel = (key: string) => {
    if (!key) return "";
    const column = draft.middle.find((c) => c.id === key && "new_name" in c);
    return column && "new_name" in column ? column.new_name : labelOf(key);
  };
  const selectedId = selected ?? "todo";
  const selectedColumn = columns.find((c) => c.id === selectedId && "status_key" in c && statusAcceptsHandoff(c.status_key));
  const selectedStep: IssueWorkflowStep | null =
    selectedColumn && "status_key" in selectedColumn
      ? { status_key: selectedColumn.status_key, ...(draft.handoffs[selectedColumn.id] ?? NO_HANDOFF) }
      : null;
  const setNewStatusGroup = (id: string, group: NewStatusGroup) =>
    setDraft((d) => ({
      ...d,
      middle: d.middle.map((c) => (c.id === id && "new_name" in c ? { ...c, status_group: group } : c)),
    }));
  const patchHandoff = (id: string, patch: Partial<Handoff>) =>
    setDraft((d) => ({ ...d, handoffs: { ...d.handoffs, [id]: { ...(d.handoffs[id] ?? NO_HANDOFF), ...patch } } }));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setDraft((d) => ({ ...d, middle: arrayMove(d.middle, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))) }));
  };

  const addNew = () => {
    const name = newName?.trim();
    if (!name) return;
    const id = `new:${name}:${Date.now()}`;
    setDraft((d) => ({ ...d, middle: [...d.middle, { id, new_name: name }] }));
    setSelected(id);
    setNewName(null);
  };

  const save = async (mapping?: Record<string, string>) => {
    const listed = new Set(targetKeys);
    const steps: IssueWorkflowStepInput[] = columns.map((c) => {
      const raw = draft.handoffs[c.id];
      const h = raw && savedHandoff(raw);
      const handoff = hasHandoff(h)
        ? {
            ...(h.handler.type !== "none" ? { handler: h.handler, instructions: h.instructions } : {}),
            ...(h.next_status_key && listed.has(h.next_status_key) ? { next_status_key: h.next_status_key } : {}),
            ...(h.back_status_key && listed.has(h.back_status_key) ? { back_status_key: h.back_status_key } : {}),
          }
        : {};
      return "status_key" in c
        ? { status_key: c.status_key, ...handoff }
        : {
            new_status: {
              name: c.new_name,
              ...(c.category ? { category: c.category } : {}),
              ...(c.status_group ? { status_group: c.status_group } : {}),
            },
            ...handoff,
          };
    });
    const body = {
      ...(isDefault ? {} : { name: draft.name.trim() }),
      description: draft.description.trim(),
      steps,
      ...(mapping ? { status_mapping: mapping } : {}),
    };
    try {
      if (workflowId) {
        await updateWorkflow.mutateAsync({ id: workflowId, ...body });
        toast.success(t(($) => $.workflows.editor.saved));
      } else {
        const created = await createWorkflow.mutateAsync({ ...body, name: draft.name.trim() });
        toast.success(t(($) => $.workflows.editor.created));
        onOpen({ id: created.id });
      }
      setMappingPlan(null);
    } catch (err) {
      const plan = mappingPlanFrom(err);
      if (plan) {
        setMappingPlan(plan);
        return;
      }
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.editor.error));
    }
  };

  const remove = async () => {
    if (!workflowId) return;
    try {
      await deleteWorkflow.mutateAsync(workflowId);
      toast.success(t(($) => $.workflows.settings.deleted));
      onBack();
    } catch (err) {
      toast.error(clientErrorMessage(err) ?? t(($) => $.workflows.settings.delete_error));
    }
  };

  if (workflowId && isLoaded && !saved) {
    return (
      <div className={EDITOR_BLEED}>
        <header className={EDITOR_HEADER}>
          <Breadcrumb onBack={onBack} current="" />
        </header>
        <p className="px-7 py-6 text-body text-muted-foreground">{t(($) => $.workflows.editor.not_found)}</p>
      </div>
    );
  }

  const title = draft.name.trim() || t(($) => $.workflows.editor.create_title);
  const middleIds = new Set(ids);
  const isOff = (column: DraftColumn) =>
    "status_key" in column &&
    ((column.status_key === "backlog" && !draft.backlog) || (column.status_key === "blocked" && !draft.blocked));
  const listed: DraftColumn[] = [
    { id: "backlog", status_key: "backlog" },
    { id: "todo", status_key: "todo" },
    ...draft.middle,
    { id: "blocked", status_key: "blocked" },
    { id: "done", status_key: "done" },
    { id: "cancelled", status_key: "cancelled" },
  ];
  const current = listed.find((c) => c.id === selectedId) ?? listed[1]!;
  const nextOf = (column: DraftColumn, h: Handoff | undefined) =>
    h?.next_status_key ?? workflowNextStatus(draftFlow, columnKey(column));
  const kindOf = (column: DraftColumn): StepKind => {
    if (!("status_key" in column)) return "new";
    if (isLocked(column.status_key)) return "locked";
    return middleIds.has(column.id) ? "middle" : "optional";
  };
  const card = (column: DraftColumn) => {
    const key = "status_key" in column ? column.status_key : null;
    const kind = kindOf(column);
    const off = isOff(column);
    const label = key ? labelOf(key) : "new_name" in column ? column.new_name : "";
    const props = {
      column,
      off,
      start: key === "todo",
      note: key === "backlog" ? t(($) => $.workflows.editor.card_no_run) : key === "done" || key === "cancelled" ? t(($) => $.workflows.editor.card_ends) : undefined,
      handoff: off ? undefined : draft.handoffs[column.id],
      nextLabel: off ? undefined : columnLabel(nextOf(column, draft.handoffs[column.id])) || undefined,
      selected: current.id === column.id,
      onSelect: () => setSelected(column.id),
      lock: isLocked(key)
        ? { label: t(($) => $.workflows.editor.lock_why, { name: label }), why: t(($) => $.workflows.editor.why[key]) }
        : undefined,
      toggle: kind === "optional"
        ? { checked: !off, disabled: !canEdit, onChange: (on: boolean) => setDraft((d) => ({ ...d, [key as OptionalStatus]: on })) }
        : undefined,
      onRemove: canEdit && middleIds.has(column.id) ? () => removeColumn(column) : undefined,
    };
    return (
      <li key={column.id}>
        {middleIds.has(column.id) ? <SortableStepCard {...props} draggable={canEdit} /> : <StepCard {...props} />}
      </li>
    );
  };
  const addStep = (key: string) => {
    setDraft((d) => ({ ...d, middle: [...d.middle, { id: key, status_key: key }] }));
    setSelected(key);
  };
  const createStep = (name: string) => {
    if (!name) {
      setNewName("");
      return;
    }
    const id = `new:${name}:${Date.now()}`;
    setDraft((d) => ({ ...d, middle: [...d.middle, { id, new_name: name }] }));
    setSelected(id);
  };
  const addPicker = (placement: "header" | "slot") => (
    <AddStepPicker
      placement={placement}
      addable={addable}
      canCreateStatus={canCreateStatus}
      onPick={addStep}
      onCreate={createStep}
    />
  );
  const replaceStatus = (column: DraftColumn, key: string) => {
    setDraft((d) => {
      const { [column.id]: moved, ...rest } = d.handoffs;
      return {
        ...d,
        middle: d.middle.map((c) => (c.id === column.id ? { id: key, status_key: key } : c)),
        handoffs: moved ? { ...rest, [key]: moved } : rest,
      };
    });
    setSelected(key);
  };
  const removeColumn = (column: DraftColumn) => {
    setDraft((d) => ({ ...d, middle: d.middle.filter((c) => c.id !== column.id) }));
    setSelected("todo");
  };

  return (
    <div className={EDITOR_BLEED}>
      <header className={EDITOR_HEADER}>
        <Breadcrumb onBack={onBack} current={title} />
        {(canEdit || canDuplicate) && (
          <div className="flex shrink-0 items-center gap-2">
            {canEdit && dirty && workflowId && (
              <span className="mr-1 flex items-center gap-1.5 text-label text-muted-foreground">
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                {t(($) => $.workflows.editor.unsaved)}
              </span>
            )}
            {canDuplicate && workflowId && (
              <Button variant="outline" className="h-9 gap-1.5 pl-3.5 pr-4" onClick={() => onOpen({ duplicateOf: workflowId })}>
                <Copy className="size-3.5" />
                {t(($) => $.workflows.editor.duplicate)}
              </Button>
            )}
            {canEdit && (
              <Button className="h-9 px-5" onClick={() => void save()} disabled={!canSave} aria-busy={pending}>
                {pending && <Spinner className="size-3.5" />}
                {workflowId ? t(($) => $.workflows.editor.save) : t(($) => $.workflows.editor.create)}
              </Button>
            )}
            {canEdit && workflowId && !isDefault && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <IconButton
                      variant="ghost"
                      size="icon"
                      className="size-9 text-muted-foreground"
                      label={t(($) => $.workflows.editor.more)}
                      tooltipSide="bottom"
                    >
                      <MoreHorizontal className="size-4" />
                    </IconButton>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={usedBy.length > 0 || deleteWorkflow.isPending}
                    onClick={() => void remove()}
                  >
                    <Trash2 className="size-3.5" />
                    {t(($) => $.workflows.settings.delete)}
                  </DropdownMenuItem>
                  {usedBy.length > 0 && (
                    <p className="px-2.5 pb-1.5 pt-0.5 text-caption leading-5 text-muted-foreground">
                      {t(($) => $.workflows.settings.delete_in_use)}
                    </p>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </header>

      <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_23.75rem]">
        <div className="min-w-0 space-y-5 px-7 py-6">
          <div>
            <InlineField editable={canEdit && !isDefault}>
              <input
                aria-label={t(($) => $.workflows.editor.name)}
                value={draft.name}
                maxLength={64}
                readOnly={!canEdit || isDefault}
                placeholder={t(($) => $.workflows.editor.name_placeholder)}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className={cn(INLINE_FIELD, "h-9.5 text-display-sm font-bold")}
              />
            </InlineField>
            <InlineField editable={canEdit} className="mt-1">
              <input
                aria-label={t(($) => $.workflows.editor.description)}
                value={draft.description}
                maxLength={256}
                readOnly={!canEdit}
                placeholder={canEdit ? t(($) => $.workflows.editor.description_placeholder) : ""}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                className={cn(INLINE_FIELD, "h-6.5 text-body-lg text-muted-foreground")}
              />
            </InlineField>
            <p className="mt-2.5 flex items-start gap-1.5 text-label leading-5 text-muted-foreground">
              <FolderKanban aria-hidden className="mt-0.75 size-3.5 shrink-0" />
              <span>
                {isDefault
                  ? t(($) => $.workflows.editor.default_note)
                  : usedBy.length > 0
                    ? t(($) => $.workflows.editor.used_by_note, {
                        count: usedBy.length,
                        names: usedBy.map((p) => p.title).join(t(($) => $.workflows.list_separator)),
                      })
                    : t(($) => $.workflows.editor.unused_note)}
              </span>
            </p>
          </div>
          <div className="space-y-5">
            <StepZone title={t(($) => $.workflows.editor.zone.start)} caption={t(($) => $.workflows.editor.zone.fixed)}>
              {card(listed[0]!)}
              {card(listed[1]!)}
            </StepZone>
            <StepZone
              title={t(($) => $.workflows.editor.zone.middle)}
              caption={t(($) => $.workflows.editor.zone.middle_caption, { count: draft.middle.length })}
              action={canEdit ? addPicker("header") : undefined}
              after={
                canEdit && (
                  <>
                    {newName !== null && (
                      <div className={cn(STEP_SHAPE, "border-dashed border-input pr-2")}>
                        <span aria-hidden className="w-4 shrink-0" />
                        <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                        <input
                          autoFocus
                          maxLength={64}
                          value={newName}
                          aria-label={t(($) => $.workflows.columns.name_placeholder)}
                          placeholder={t(($) => $.workflows.columns.name_placeholder)}
                          onChange={(e) => setNewName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") addNew();
                            if (e.key === "Escape") setNewName(null);
                          }}
                          className="h-full min-w-0 flex-1 bg-transparent text-body-lg outline-none placeholder:text-muted-foreground"
                        />
                        <Button variant="ghost" className="h-8 px-3" onClick={() => setNewName(null)}>
                          {t(($) => $.workflows.editor.cancel)}
                        </Button>
                        <Button variant="secondary" className="h-8 px-3.5" onClick={addNew} disabled={!newName.trim()}>
                          {t(($) => $.workflows.columns.add)}
                        </Button>
                      </div>
                    )}
                    {addPicker("slot")}
                  </>
                )
              }
            >
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                  {draft.middle.map(card)}
                </SortableContext>
              </DndContext>
            </StepZone>
            <StepZone title={t(($) => $.workflows.editor.zone.blocked)} caption={t(($) => $.workflows.editor.zone.blocked_caption)}>
              {card(listed[listed.length - 3]!)}
            </StepZone>
            <StepZone title={t(($) => $.workflows.editor.zone.end)} caption={t(($) => $.workflows.editor.zone.fixed)}>
              {listed.slice(-2).map(card)}
            </StepZone>
            {canEdit && missingStatuses.length > 0 && (
              <p role="alert" className="mt-2.5 text-caption leading-5 text-destructive">
                {t(($) => $.workflows.editor.status_needs_admin, {
                  names: missingStatuses.join(t(($) => $.workflows.list_separator)),
                })}
              </p>
            )}
            <p className="mt-2.5 text-label leading-5 text-muted-foreground">{t(($) => $.workflows.editor.steps_hint)}</p>
          </div>
        </div>

        <StepDetail
          key={current.id}
          column={current}
          kind={kindOf(current)}
          off={isOff(current)}
          handoff={draft.handoffs[current.id]}
          flow={flow}
          defaultNextLabel={columnLabel(workflowNextStatus(draftFlow, columnKey(current)))}
          canEdit={canEdit}
          statusOptions={middleIds.has(current.id) ? addable : null}
          onReplaceStatus={(key) => replaceStatus(current, key)}
          onRemove={canEdit && middleIds.has(current.id) ? () => removeColumn(current) : undefined}
          onPatch={(patch) => patchHandoff(current.id, patch)}
          onGroupChange={(group) => setNewStatusGroup(current.id, group)}
          onPreview={
            saved && "status_key" in current && saved.steps.some((s) => s.status_key === current.status_key)
              ? () => setPreviewOpen(true)
              : undefined
          }
        />
        {saved && selectedStep && (
          <BriefPreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} workflowId={saved.id} step={selectedStep} />
        )}
      </div>

      <WorkflowMappingDialog
        open={mappingPlan !== null}
        onOpenChange={(open) => !open && setMappingPlan(null)}
        variant={{ kind: "edit", workflowName: draft.name.trim() }}
        plan={mappingPlan}
        targetKeys={targetKeys}
        pending={pending}
        onConfirm={(mapping) => void save(mapping)}
      />
    </div>
  );
}

function Breadcrumb({ onBack, current }: { onBack: () => void; current: string }) {
  const { t } = useT("issues");
  const workspace = useCurrentWorkspace();
  return (
    <nav className="flex min-w-0 flex-1 items-center gap-2 text-body text-muted-foreground">
      {workspace?.name && (
        <>
          <span className="truncate">{workspace.name}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        </>
      )}
      <button type="button" onClick={onBack} className="shrink-0 transition-colors hover:text-foreground">
        {t(($) => $.workflows.settings.title)}
      </button>
      {current && (
        <>
          <ChevronRight aria-hidden className="size-3 shrink-0" />
          <span className="truncate font-medium text-foreground">{current}</span>
        </>
      )}
    </nav>
  );
}

/** 名称和描述的就地编辑框：悬停时右侧出现铅笔，提示这里可以改。 */
function InlineField({ editable, className, children }: { editable: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("group/field relative", className)}>
      {children}
      {editable && (
        <Pencil
          aria-hidden
          className="pointer-events-none absolute right-1 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/field:opacity-100 group-focus-within/field:opacity-0"
        />
      )}
    </div>
  );
}

/** 步骤分组：组头是标题、灰字说明和可选操作，下面是这一组的步骤。 */
function StepZone({
  title,
  caption,
  action,
  after,
  children,
}: {
  title: string;
  caption: string;
  action?: React.ReactNode;
  /** Rendered under the steps, outside the list. */
  after?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <header className="flex h-7 items-center gap-2 px-1">
        <h3 className="text-label font-semibold">{title}</h3>
        <span className="min-w-0 truncate text-caption text-muted-foreground">{caption}</span>
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </header>
      <ol className="flex flex-col gap-1.5">{children}</ol>
      {after && <div className="flex flex-col gap-1.5">{after}</div>}
    </section>
  );
}

/**
 * 添加步骤：组头按钮和组尾虚线框共用一份菜单。可搜索状态库，
 * 有搜索词时「新建状态」直接用这个名字建一步。
 */
function AddStepPicker({
  placement,
  addable,
  canCreateStatus,
  onPick,
  onCreate,
}: {
  placement: "header" | "slot";
  addable: string[];
  canCreateStatus: boolean;
  onPick: (key: string) => void;
  /** An empty name asks for one inline. */
  onCreate: (name: string) => void;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const name = query.trim();
  const q = name.toLowerCase();
  const matched = addable.filter((key) => !q || labelOf(key).toLowerCase().includes(q) || key.includes(q));
  const label = (
    <>
      <Plus aria-hidden className="size-3.5" />
      {t(($) => $.workflows.editor.add_step)}
    </>
  );

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      align={placement === "header" ? "end" : "start"}
      width="w-64"
      searchable
      searchPlaceholder={t(($) => $.workflows.editor.search_status)}
      onSearchChange={setQuery}
      triggerRender={
        placement === "header" ? (
          <Button variant="ghost" className="h-7 gap-1 px-2.5 text-label font-medium" />
        ) : (
          <Button
            variant="ghost"
            className="h-11 w-full gap-1.5 rounded-xl border-[1.5px] border-dashed border-input font-normal text-muted-foreground"
          />
        )
      }
      trigger={label}
      footer={
        canCreateStatus && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCreate(name);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-body transition-colors hover:bg-accent"
          >
            <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">
              {name ? t(($) => $.workflows.editor.new_status_named, { name }) : t(($) => $.workflows.columns.new_status)}
            </span>
          </button>
        )
      }
    >
      {matched.length > 0 ? (
        <PickerSection label={t(($) => $.workflows.editor.library)}>
          {matched.map((key) => (
            <PickerItem
              key={key}
              selected={false}
              onClick={() => {
                setOpen(false);
                onPick(key);
              }}
            >
              <StatusIcon
                status={key}
                category={catalog.categoryOf(key)}
                color={catalog.colorOf(key)}
                icon={catalog.iconOf(key)}
                className="h-3.5 w-3.5 shrink-0"
              />
              <span className="min-w-0 flex-1 truncate">{labelOf(key)}</span>
              <span className="shrink-0 text-caption text-muted-foreground">
                {t(($) => $.board.status_column[catalog.groupOf(key)])}
              </span>
            </PickerItem>
          ))}
        </PickerSection>
      ) : (
        <p className="px-2 py-3 text-center text-caption text-muted-foreground">
          {addable.length > 0 ? t(($) => $.workflows.editor.no_match) : t(($) => $.workflows.editor.no_other_status)}
        </p>
      )}
    </PropertyPicker>
  );
}

interface StepCardProps {
  column: DraftColumn;
  /** Backlog or blocked switched off: the workflow leaves the status out. */
  off: boolean;
  /** The step new issues start on. */
  start: boolean;
  /** What a step that never hands off does, in place of a handler. */
  note?: string;
  handoff: Handoff | undefined;
  /** Where the handler is told to move the issue next, by label. */
  nextLabel: string | undefined;
  selected: boolean;
  onSelect: () => void;
  /** A step every workflow keeps, and why. */
  lock?: { label: string; why: string };
  toggle?: { checked: boolean; disabled: boolean; onChange: (on: boolean) => void };
  onRemove?: () => void;
}

function SortableStepCard({ draggable, ...props }: StepCardProps & { draggable: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.column.id,
    disabled: !draggable,
  });
  return (
    <StepCard
      {...props}
      sortable={{
        ref: setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        dragging: isDragging,
        handle: draggable ? { ...attributes, ...listeners } : undefined,
      }}
    />
  );
}

/**
 * One step of the editor's list: its status and what entering it does.
 * Middle steps drag; backlog and blocked switch on and off.
 */
function StepCard({
  column,
  off,
  start,
  note,
  handoff,
  nextLabel,
  selected,
  onSelect,
  lock,
  toggle,
  onRemove,
  sortable,
}: StepCardProps & {
  sortable?: {
    ref: (node: HTMLElement | null) => void;
    style: React.CSSProperties;
    dragging: boolean;
    handle?: React.HTMLAttributes<HTMLButtonElement>;
  };
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const handlerLabel = useStepHandlerLabel(null);
  const { getActorName } = useActorName();
  const label = "status_key" in column ? labelOf(column.status_key) : column.new_name;
  const step = handoff ? { status_key: columnKey(column), ...handoff } : undefined;
  const who = handlerLabel(step);
  const actor = stepHandlerActor(step, null);

  return (
    <div
      ref={sortable?.ref}
      style={sortable?.style}
      className={cn(
        STEP_SHAPE,
        "group/card transition-colors duration-(--motion-fast) ease-out",
        selected ? "border-foreground bg-field" : "border-transparent bg-field hover:bg-field-hover",
        off && !selected && "border-dashed border-input bg-transparent hover:bg-transparent",
        sortable?.dragging && "z-10 shadow-[var(--surface-shadow)]",
      )}
    >
      {sortable?.handle ? (
        <TooltipHint label={t(($) => $.workflows.editor.reorder, { name: label })}>
          <button
            type="button"
            aria-label={t(($) => $.workflows.editor.reorder, { name: label })}
            className="flex h-5 w-4 shrink-0 touch-none items-center justify-center rounded-xs cursor-grab text-muted-foreground active:cursor-grabbing"
            {...sortable.handle}
          >
            <GripVertical className="size-3.25" />
          </button>
        </TooltipHint>
      ) : (
        <span className="h-5 w-4 shrink-0" />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cn("flex h-full min-w-0 flex-1 items-center gap-2 text-left", off && "opacity-60")}
      >
        {"status_key" in column ? (
          <StatusIcon
            status={column.status_key}
            category={catalog.categoryOf(column.status_key)}
            color={catalog.colorOf(column.status_key)}
            icon={catalog.iconOf(column.status_key)}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : (
          <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="flex min-w-21 max-w-[45%] shrink-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-body-lg font-semibold">{label}</span>
          {start && <Badge>{t(($) => $.workflows.editor.start)}</Badge>}
          {!("status_key" in column) && <Badge>{t(($) => $.workflows.editor.new_badge)}</Badge>}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-label text-muted-foreground">
          {off ? (
            <span className="truncate">{t(($) => $.workflows.editor.step_off_short)}</span>
          ) : note ? (
            <span className="truncate">{note}</span>
          ) : who ? (
            <>
              <CornerDownRight aria-hidden className="size-3.25 shrink-0" />
              <span className="shrink-0">{t(($) => $.workflows.editor.card_hand_to)}</span>
              {actor && <ActorAvatar actorType={actor.type} actorId={actor.id} size="sm" profileLink={false} />}
              <span className="min-w-0 truncate font-medium text-foreground">{actor ? getActorName(actor.type, actor.id) : who}</span>
              {handoff?.handler.type === "agent" && nextLabel && (
                <span className="ml-auto shrink-0 whitespace-nowrap pl-1">· {t(($) => $.workflows.editor.card_then, { status: nextLabel })}</span>
              )}
            </>
          ) : (
            <>
              <UserRound aria-hidden className="size-3.25 shrink-0" />
              <span className="truncate">{t(($) => $.workflows.handler.none)}</span>
            </>
          )}
        </span>
      </button>
      {lock && (
        <TooltipHint label={<span className="block max-w-64">{lock.why}</span>}>
          <button
            type="button"
            aria-label={lock.label}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-field-hover hover:text-foreground"
          >
            <Lock className="size-3.25" />
          </button>
        </TooltipHint>
      )}
      {toggle && (
        <Switch
          checked={toggle.checked}
          disabled={toggle.disabled}
          onCheckedChange={toggle.onChange}
          aria-label={t(($) => $.workflows.editor.include_status, { status: label })}
        />
      )}
      {onRemove && (
        <IconButton
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-(--motion-fast) group-hover/card:opacity-100 focus-visible:opacity-100"
          label={t(($) => $.workflows.editor.remove_named, { name: label })}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      )}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-field px-1.5 py-px text-micro font-normal text-muted-foreground">{children}</span>
  );
}

/** The selected step: its status and its handoff. */
function StepDetail({
  column,
  kind,
  off,
  handoff,
  flow,
  canEdit,
  statusOptions,
  onReplaceStatus,
  onRemove,
  onPatch,
  onGroupChange,
  onPreview,
  defaultNextLabel,
}: {
  column: DraftColumn;
  kind: StepKind;
  off: boolean;
  handoff: Handoff | undefined;
  flow: Pick<IssueWorkflow, "steps">;
  canEdit: boolean;
  /** Statuses a middle step can switch to; null for fixed steps. */
  statusOptions: string[] | null;
  onReplaceStatus: (key: string) => void;
  onRemove?: () => void;
  onPatch: (patch: Partial<Handoff>) => void;
  /** Picks the board group of a status the save will create. */
  onGroupChange: (group: NewStatusGroup) => void;
  onPreview?: () => void;
  /** The default next status's label, resolved over the whole draft. */
  defaultNextLabel: string;
}) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const catalog = useIssueStatuses(wsId);
  const labelOf = useStatusLabel(wsId);
  const key = "status_key" in column ? column.status_key : null;
  const label = key ? labelOf(key) : "new_name" in column ? column.new_name : "";
  const icon = (statusKey: string, className = "h-3.5 w-3.5 shrink-0") => (
    <StatusIcon
      status={statusKey}
      category={catalog.categoryOf(statusKey)}
      color={catalog.colorOf(statusKey)}
      icon={catalog.iconOf(statusKey)}
      className={className}
    />
  );
  const statusField = (
    <span className="flex min-w-0 items-center gap-2">
      {key ? icon(key) : <Plus aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
      <span className="truncate">{label}</span>
    </span>
  );
  const kindLabel = {
    locked: t(($) => $.workflows.editor.kind.locked),
    optional: off ? t(($) => $.workflows.editor.kind.optional_off) : t(($) => $.workflows.editor.kind.optional),
    middle: t(($) => $.workflows.editor.kind.middle),
    new: t(($) => $.workflows.editor.kind.new),
  }[kind];
  const rule =
    kind === "locked" && isLocked(key)
      ? { icon: Lock, title: t(($) => $.workflows.editor.rule_locked), body: t(($) => $.workflows.editor.why[key]) }
      : kind === "optional" && (key === "backlog" || key === "blocked")
        ? { icon: ToggleRight, title: t(($) => $.workflows.editor.rule_optional), body: t(($) => $.workflows.editor.why[key]) }
        : null;

  return (
    <section className="min-w-0 space-y-5 border-t border-surface-border p-6 lg:border-t-0 lg:border-l">
      <header className="flex min-h-8 items-center gap-2">
        {key ? icon(key, "h-4 w-4 shrink-0") : <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
        <h3 className="min-w-0 truncate text-title-sm font-semibold">{label}</h3>
        <code className="shrink truncate font-mono text-caption text-muted-foreground">
          {key ?? t(($) => $.workflows.editor.key_on_save)}
        </code>
        <Badge>{kindLabel}</Badge>
        {onRemove && (
          <Button
            variant="ghost"
            className="ml-auto h-8 shrink-0 gap-1.5 px-2.5 text-label text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 aria-hidden className="size-3.5" />
            {t(($) => $.workflows.editor.remove)}
          </Button>
        )}
      </header>
      {rule && (
        <div className="flex gap-2.5 rounded-lg bg-field px-3.5 py-3">
          <rule.icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-label font-medium">{rule.title}</p>
            <p className="text-caption leading-5 text-muted-foreground">{rule.body}</p>
          </div>
        </div>
      )}
      <div className="space-y-5">
        <DetailField label={t(($) => $.workflows.editor.status)} hint={key ? t(($) => $.workflows.editor.status_hint) : t(($) => $.workflows.editor.status_new_hint)}>
          {statusOptions && canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    className="flex h-11 w-full items-center justify-between gap-2 rounded-lg bg-field px-3.5 text-body transition-colors hover:bg-field-hover"
                  />
                }
              >
                {statusField}
                <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 w-(--anchor-width) overflow-y-auto">
                {statusOptions.length === 0 ? (
                  <p className="px-2 py-1.5 text-caption text-muted-foreground">{t(($) => $.workflows.editor.no_other_status)}</p>
                ) : (
                  statusOptions.map((option) => (
                    <DropdownMenuItem key={option} onClick={() => onReplaceStatus(option)}>
                      {icon(option)}
                      <span className="truncate">{labelOf(option)}</span>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <div className="flex h-11 w-full items-center rounded-lg bg-surface-sunken px-3.5 text-body text-muted-foreground">
              {statusField}
            </div>
          )}
        </DetailField>
        {"new_name" in column && column.category !== "unstarted" && (
          <DetailField label={t(($) => $.workflows.editor.status_group)} hint={t(($) => $.workflows.editor.status_group_hint)}>
            <div
              role="radiogroup"
              aria-label={t(($) => $.workflows.editor.status_group)}
              className="flex gap-0.5 rounded-lg bg-field p-0.75"
            >
              {NEW_STATUS_GROUPS.map((group) => {
                const selected = (column.status_group ?? "working") === group;
                return (
                  <button
                    key={group}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!canEdit}
                    onClick={() => onGroupChange(group)}
                    className={cn(
                      "min-h-8 min-w-0 flex-1 rounded-md px-1.5 py-1 text-center text-label leading-tight transition-colors duration-(--motion-fast) ease-out disabled:cursor-default",
                      selected
                        ? "bg-surface font-medium text-foreground shadow-control dark:bg-white/12"
                        : "text-muted-foreground enabled:hover:text-foreground",
                    )}
                  >
                    {t(($) => $.board.status_column[group])}
                  </button>
                );
              })}
            </div>
          </DetailField>
        )}
        <DetailField label={t(($) => $.workflows.editor.on_enter)}>
          {off ? (
            <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.editor.step_off)}</p>
          ) : !key || statusAcceptsHandoff(key) ? (
            // A new status is a middle column, so it always takes a handoff;
            // the save creates the status and keeps the handoff on it.
            <HandoffFields
              step={{ status_key: columnKey(column), ...(handoff ?? NO_HANDOFF) }}
              workflow={flow}
              canEdit={canEdit}
              onPatch={onPatch}
              onPreview={onPreview}
              defaultNextLabel={defaultNextLabel}
            />
          ) : (
            <p className="text-caption leading-5 text-muted-foreground">{t(($) => $.workflows.editor.no_handoff_step)}</p>
          )}
        </DetailField>
      </div>
    </section>
  );
}

function DetailField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-label font-medium">{label}</p>
      {children}
      {hint && <p className="text-caption leading-5 text-muted-foreground">{hint}</p>}
    </div>
  );
}
