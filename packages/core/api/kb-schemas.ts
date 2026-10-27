import { z } from "zod";
import type {
  KbAnnotation,
  KbAnnotationStatus,
  KbBuilderSession,
  KbBuilderSessionStart,
  KnowledgeBaseMutation,
  KbTemplates,
  KbHome,
  KbPage,
  KbRevision,
  KbRevisionDiff,
  KbTreeLevel,
  KnowledgeBase,
  KnowledgeBaseDetail,
  KnowledgeBasePending,
  KbSearchMode,
  KbSearchResult,
  KbDraftDetail,
  KbDraftDiffLine,
  KbDraftStatus,
  KbJob,
  KbJobDetail,
  KbJobStarter,
  KbJobState,
  KbMergeRequestCreated,
  KbMergeRequestStatus,
  KbMergeRequest,
  KbMergeRequestDetail,
  KbMergeRequestOriginType,
  KbMrComment,
  KbMrReview,
  KbMrReviewState,
  KbMrEventKind,
  KbMrTimelineEntry,
  KbMrHandoff,
  KbRawFileItem,
  KbStalePage,
  KbRawUploadedFile,
  KbGraph,
  KbDeleteResult,
} from "../types/kb";

// Knowledge base response schemas. Kept out of schemas.ts so the knowledge
// base surface (pages, revisions, merge requests) can grow in one place.
// Schemas are lenient: enums stay plain strings and counters fall back to 0,
// so an older or newer backend degrades to sensible values instead of failing
// the whole response.

const countSchema = z.number().catch(0);

function emptyPending(): KnowledgeBasePending {
  return { annotations: 0, stale_pages: 0, open_mrs: 0 };
}

export const KnowledgeBasePendingSchema = z
  .object({
    annotations: countSchema,
    stale_pages: countSchema,
    open_mrs: countSchema,
  })
  .loose();

const optionalText = z
  .string()
  .nullable()
  .optional()
  .transform((v) => v ?? "");

export const KnowledgeBaseSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string().catch(""),
    name: z.string(),
    slug: z.string(),
    description: optionalText,
    schema_mode: z.string().catch("default"),
    created_by: optionalText,
    page_count: countSchema,
    content_version: countSchema,
    created_at: z.string().catch(""),
    updated_at: z.string().catch(""),
    pending: KnowledgeBasePendingSchema.nullable()
      .catch(null)
      .transform((v) => v ?? emptyPending()),
  })
  .loose();

export const KnowledgeBaseListSchema = z.array(KnowledgeBaseSchema);

export const KnowledgeBaseDetailSchema = KnowledgeBaseSchema.extend({
  purpose: optionalText,
  schema: optionalText,
}).loose();

export const EMPTY_KNOWLEDGE_BASE_LIST: KnowledgeBase[] = [];

export const EMPTY_KNOWLEDGE_BASE_DETAIL: KnowledgeBaseDetail = {
  id: "",
  workspace_id: "",
  name: "",
  slug: "",
  description: "",
  schema_mode: "default",
  created_by: "",
  page_count: 0,
  content_version: 0,
  created_at: "",
  updated_at: "",
  pending: emptyPending(),
  purpose: "",
  schema: "",
};

// Pages, the page tree, the home page and page history.

const text = optionalText;
const flag = z.boolean().catch(false);

/** An array whose malformed entries are dropped rather than failing it. */
function lenientArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .nullable()
    .optional()
    .catch([])
    .transform((items) =>
      (items ?? []).flatMap((entry) => {
        const parsed = item.safeParse(entry);
        return parsed.success ? [parsed.data as z.infer<T>] : [];
      }),
    );
}

function nullableObject<T extends z.ZodType>(schema: T) {
  return schema
    .nullable()
    .optional()
    .catch(null)
    .transform((v) => v ?? null);
}

const KbPageRefSchema = z.object({ id: z.string(), title: text }).loose();

const KbBlockSchema = z
  .object({ id: z.string(), kind: z.string().catch("text"), content: text })
  .loose();

const KbRawFileSchema = z
  .object({
    id: z.string(),
    name: text,
    content_type: text,
    size: countSchema,
    uploaded_by: text,
    created_at: text,
    page: countSchema,
  })
  .loose();

const KbSourceSchema = z
  .object({
    id: z.string(),
    kind: z.string().catch("other"),
    uri: text,
    title: text,
    version: text,
    openable: flag,
    raw: nullableObject(KbRawFileSchema),
  })
  .loose();

const KbClaimSchema = z
  .object({ key: text, block_id: text, text: text, checked_at: text })
  .loose();

const KbLastMergeSchema = z
  .object({
    number: countSchema,
    author_type: text,
    author_id: text,
    author_name: text,
    merged_at: text,
  })
  .loose();

const KbMergeRequestRefSchema = z.object({ number: countSchema, title: text }).loose();

const KbPageDraftSchema = z
  .object({
    id: z.string(),
    title: text,
    status: text,
    updated_at: text,
    draft_change: text,
    changed_blocks: countSchema,
    origin: z
      .object({ type: text, label: text, ref_id: text })
      .loose()
      .catch({ type: "none", label: "", ref_id: "" }),
  })
  .loose();

export const KbPageSchema = z
  .object({
    id: z.string(),
    knowledge_base_id: text,
    path: text,
    version: text,
    breadcrumb: lenientArray(KbPageRefSchema),
    frontmatter: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .catch({})
      .transform((v) => v ?? {}),
    blocks: lenientArray(KbBlockSchema),
    sources: lenientArray(KbSourceSchema),
    claims: lenientArray(KbClaimSchema),
    last_mr: nullableObject(KbLastMergeSchema),
    updated_at: text,
    stale: flag,
    backlinks: lenientArray(KbPageRefSchema),
    pending_mr: nullableObject(KbMergeRequestRefSchema),
    pending_mr_count: countSchema,
    annotations_open: countSchema,
    draft_change: text,
    drafts: lenientArray(KbPageDraftSchema),
  })
  .loose();

const KbTreePageSchema = z
  .object({
    id: z.string(),
    path: text,
    title: text,
    type: text,
    description: text,
    has_child: flag,
    child_count: countSchema,
    stale: flag,
    open_annotations: countSchema,
    draft_change: text,
  })
  .loose();

export const KbTreeLevelSchema = z
  .object({
    version: countSchema,
    parent: nullableObject(z.object({ id: z.string(), path: text, title: text }).loose()),
    pages: lenientArray(KbTreePageSchema),
    next_cursor: text,
    total: countSchema,
  })
  .loose();

const EMPTY_HOME_PENDING = {
  annotations: 0,
  agent_reported: 0,
  stale_pages: 0,
  open_mrs: 0,
  latest_mr: null,
};

export const KbHomeSchema = z
  .object({
    knowledge_base: KnowledgeBaseSchema,
    pending: z
      .object({
        annotations: countSchema,
        agent_reported: countSchema,
        stale_pages: countSchema,
        open_mrs: countSchema,
        latest_mr: nullableObject(KbMergeRequestRefSchema),
      })
      .loose()
      .catch(EMPTY_HOME_PENDING),
    recent: lenientArray(
      z
        .object({
          page_id: z.string(),
          path: text,
          title: text,
          mr_number: countSchema,
          mr_title: text,
          merged_at: text,
        })
        .loose(),
    ),
    running_jobs: countSchema,
  })
  .loose();

const KbRevisionSchema = z
  .object({
    revision_id: z.string(),
    mr_number: z
      .number()
      .nullable()
      .optional()
      .catch(null)
      .transform((v) => v ?? null),
    mr_title: text,
    source: text,
    author_type: text,
    author_id: text,
    author_name: text,
    merged_by: text,
    merged_by_name: text,
    merged_at: text,
    annotations: countSchema,
    added: countSchema,
    deleted: countSchema,
    current: flag,
  })
  .loose();

export const KbRevisionListSchema = lenientArray(KbRevisionSchema);

const KbDiffLineSchema = z
  .object({
    op: z.string().catch("equal"),
    old_line: countSchema,
    new_line: countSchema,
    text: text,
  })
  .loose();

export const KbRevisionDiffSchema = z
  .object({
    revision: KbRevisionSchema,
    prev_revision_id: text,
    hunks: lenientArray(z.object({ heading: text, lines: lenientArray(KbDiffLineSchema) }).loose()),
  })
  .loose();

export const EMPTY_KB_PAGE: KbPage = {
  id: "",
  knowledge_base_id: "",
  path: "",
  version: "",
  breadcrumb: [],
  frontmatter: {},
  blocks: [],
  sources: [],
  claims: [],
  last_mr: null,
  updated_at: "",
  stale: false,
  backlinks: [],
  pending_mr: null,
  pending_mr_count: 0,
  annotations_open: 0,
  draft_change: "",
  drafts: [],
};

export const EMPTY_KB_TREE_LEVEL: KbTreeLevel = {
  version: 0,
  parent: null,
  pages: [],
  next_cursor: "",
  total: 0,
};

export const EMPTY_KB_HOME: KbHome = {
  knowledge_base: EMPTY_KNOWLEDGE_BASE_DETAIL,
  pending: EMPTY_HOME_PENDING,
  recent: [],
  running_jobs: 0,
};

export const EMPTY_KB_REVISION_LIST: KbRevision[] = [];

export const EMPTY_KB_REVISION_DIFF: KbRevisionDiff = {
  revision: {
    revision_id: "",
    mr_number: null,
    mr_title: "",
    source: "",
    author_type: "",
    author_id: "",
    author_name: "",
    merged_by: "",
    merged_by_name: "",
    merged_at: "",
    annotations: 0,
    added: 0,
    deleted: 0,
    current: false,
  },
  prev_revision_id: "",
  hunks: [],
};

// Builder conversations and configuration writes.

const schemaModeSchema = z.enum(["default", "custom"]).catch("default");

const nullableText = z
  .string()
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? null);

/** A stored right-hand configuration; unknown or broken fields fall back. */
export const StoredKbDraftSchema = z
  .object({
    name: text,
    slug: text,
    description: text,
    purpose: text,
    schema_mode: schemaModeSchema,
    schema: text,
    applied_message_id: nullableText,
  })
  .loose();

const KbBuilderSessionSchema = z
  .object({
    session_id: z.string(),
    mode: z.string().catch("create"),
    knowledge_base_id: nullableText,
    title: text,
    runtime_id: text,
    last_message_content: text,
    last_message_role: text,
    last_message_at: nullableText,
    draft: nullableObject(StoredKbDraftSchema),
    updated_at: text,
  })
  .loose();

export const KbBuilderSessionListSchema = lenientArray(KbBuilderSessionSchema);

export const KbBuilderSessionStartSchema = z
  .object({ session_id: z.string(), builder_agent_id: text, runtime_id: text })
  .loose();

export const KbBuilderRuntimeSwitchSchema = z
  .object({ session_id: text, runtime_id: z.string() })
  .loose();

export const KnowledgeBaseMutationSchema = KnowledgeBaseSchema.extend({ mention: text }).loose();

export const KbTemplatesSchema = z
  .object({ default_schema: text, purpose_template: text })
  .loose();

export const EMPTY_KB_TEMPLATES: KbTemplates = { default_schema: "", purpose_template: "" };

export const EMPTY_KB_BUILDER_SESSION_LIST: KbBuilderSession[] = [];

export const EMPTY_KB_BUILDER_SESSION_START: KbBuilderSessionStart = {
  session_id: "",
  builder_agent_id: "",
  runtime_id: "",
};

/** A rebind that answered 2xx committed `runtimeId`, whatever the body says. */
export function kbBuilderRuntimeSwitchFallback(runtimeId: string): { session_id: string; runtime_id: string } {
  return { session_id: "", runtime_id: runtimeId };
}

/**
 * A write that answered 2xx committed; when its body does not parse, the
 * caller still knows the slug it sent, which is all navigation needs.
 */
export function knowledgeBaseMutationFallback(slug: string): KnowledgeBaseMutation {
  return { ...EMPTY_KNOWLEDGE_BASE_DETAIL, slug, mention: "" };
}

// Annotations (spec 7.6).

const ANNOTATION_STATUSES: readonly KbAnnotationStatus[] = ["pending", "processing", "resolved", "dismissed"];

/** An unknown status reads as pending: still waiting for someone. */
const annotationStatus = z
  .string()
  .catch("pending")
  .transform((v): KbAnnotationStatus => (ANNOTATION_STATUSES.includes(v as KbAnnotationStatus) ? (v as KbAnnotationStatus) : "pending"));

const nullableId = z
  .string()
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => (v ? v : null));

export const KbAnnotationSchema = z
  .object({
    id: z.string(),
    knowledge_base_id: text,
    page_id: nullableId,
    page_path: text,
    page_title: text,
    block_id: text,
    block_index: countSchema,
    quote: text,
    original_quote: text,
    prefix: text,
    suffix: text,
    body: text,
    author_type: z
      .string()
      .catch("member")
      .transform((v): "member" | "agent" => (v === "agent" ? "agent" : "member")),
    author_id: text,
    author_name: text,
    status: annotationStatus,
    anchor_lost: flag,
    merge_request_id: nullableId,
    mr_number: z.number().nullable().optional().catch(null).transform((v) => v ?? null),
    created_at: text,
    updated_at: text,
    mention: text,
  })
  .loose();

export const KbAnnotationListSchema = lenientArray(KbAnnotationSchema);

export const EMPTY_KB_ANNOTATION_LIST: KbAnnotation[] = [];

/** What a write answers with when its response cannot be read. */
export function kbAnnotationFallback(id = ""): KbAnnotation {
  return {
    id,
    knowledge_base_id: "",
    page_id: null,
    page_path: "",
    page_title: "",
    block_id: "",
    block_index: 0,
    quote: "",
    original_quote: "",
    prefix: "",
    suffix: "",
    body: "",
    author_type: "member",
    author_id: "",
    author_name: "",
    status: "pending",
    anchor_lost: false,
    merge_request_id: null,
    mr_number: null,
    created_at: "",
    updated_at: "",
    mention: "",
  };
}

// Search.

const KB_SEARCH_MODES = ["hybrid", "keyword"] as const satisfies readonly KbSearchMode[];

export const KbSearchHitSchema = z
  .object({
    page_id: z.string(),
    slug: text,
    path: text,
    parents: z
      .array(z.unknown())
      .nullable()
      .optional()
      .catch([])
      .transform((items) => (items ?? []).filter((item): item is string => typeof item === "string")),
    title: text,
    type: text,
    block_id: text,
    excerpt: text,
    score: z.number().catch(0),
    mention: text,
  })
  .loose();

export const KbSearchResultSchema = z
  .object({
    // An unknown mode reads as keyword: the hits are still usable.
    mode: z.enum(KB_SEARCH_MODES).catch("keyword"),
    total: countSchema,
    hits: lenientArray(KbSearchHitSchema),
  })
  .loose();

export const EMPTY_KB_SEARCH_RESULT: KbSearchResult = { mode: "keyword", total: 0, hits: [] };

// Jobs (spec 7.10). Unknown enums fall back to the value that keeps the job
// page usable: a custom starter, an idle state, an open draft.

const KB_JOB_STARTERS = [
  "ingest",
  "health",
  "merge",
  "annotations",
  "new_page",
  "schedule",
  "custom",
] as const satisfies readonly KbJobStarter[];
const KB_JOB_STATES = ["running", "idle", "failed", "stopped"] as const satisfies readonly KbJobState[];
const KB_DRAFT_STATUSES = ["open", "submitted", "merged", "discarded"] as const satisfies readonly KbDraftStatus[];
const KB_MR_STATUSES = ["open", "changes_requested", "merged", "closed"] as const satisfies readonly KbMergeRequestStatus[];
const KB_MR_REVIEW_STATES = ["pending", "submitted"] as const satisfies readonly KbMrReviewState[];
const KB_MR_EVENT_KINDS = [
  "review_submitted",
  "review_requested",
  "merged",
  "closed",
  "reverted",
  "edited",
  "unknown",
] as const satisfies readonly KbMrEventKind[];
const KB_DIFF_KINDS = ["context", "add", "delete"] as const satisfies readonly KbDraftDiffLine["kind"][];
const KB_DRAFT_CHANGES = ["added", "modified", "moved", "deleted"] as const;

const KbJobDraftSchema = z
  .object({
    version: countSchema,
    status: z.enum(KB_DRAFT_STATUSES).catch("open"),
    pages: countSchema,
    added: countSchema,
    deleted: countSchema,
  })
  .loose();

const KbJobMergeRequestSchema = z
  .object({
    id: z.string(),
    number: countSchema,
    title: text,
    status: z.enum(KB_MR_STATUSES).catch("open"),
    author_type: text,
    author_id: text,
    author_name: text,
    merged_by_name: text,
    closed_by_name: text,
    close_reason: text,
  })
  .loose();

export const KbJobSchema = z
  .object({
    id: z.string(),
    knowledge_base_id: text,
    name: text,
    starter: z.enum(KB_JOB_STARTERS).catch("custom"),
    agent_id: text,
    agent_name: text,
    chat_session_id: text,
    draft_id: nullableId,
    created_by: text,
    state: z.enum(KB_JOB_STATES).catch("idle"),
    last_reply: text,
    draft: KbJobDraftSchema.nullable().optional().catch(null).transform((v) => v ?? null),
    merge_request: KbJobMergeRequestSchema.nullable().optional().catch(null).transform((v) => v ?? null),
    annotation_ids: z
      .array(z.unknown())
      .nullable()
      .optional()
      .catch([])
      .transform((items) => (items ?? []).filter((item): item is string => typeof item === "string")),
    page_id: nullableId,
    created_at: text,
    updated_at: text,
  })
  .loose();

export const KbJobListSchema = lenientArray(KbJobSchema);

const KbDraftDiffLineSchema = z
  .object({
    kind: z.enum(KB_DIFF_KINDS).catch("context"),
    text: text,
    block_id: text,
    old_line: countSchema,
    new_line: countSchema,
  })
  .loose();

const KbDraftPageChangeSchema = z
  .object({
    page_id: z.string(),
    path: text,
    old_path: text,
    title: text,
    change: z.enum(KB_DRAFT_CHANGES).catch("modified"),
    added: countSchema,
    deleted: countSchema,
    lines: lenientArray(KbDraftDiffLineSchema),
  })
  .loose();

const KbLintFindingSchema = z
  .object({
    code: text,
    // An unknown severity does not block: only "error" does.
    severity: z.enum(["error", "warning"]).catch("warning"),
    page_id: text,
    path: text,
    block_id: text,
    message: text,
  })
  .loose();

const KbDraftConflictSchema = z
  .object({
    page_id: text,
    path: text,
    kind: text,
    block_id: text,
    main_lines: text,
    draft_lines: text,
  })
  .loose();

const KbDraftChecksSchema = z
  .object({
    lint: lenientArray(KbLintFindingSchema),
    conflicts: lenientArray(KbDraftConflictSchema),
  })
  .loose()
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? { lint: [], conflicts: [] });

export const KbJobDetailSchema = KbJobSchema.extend({
  pages: lenientArray(KbDraftPageChangeSchema),
  checks: KbDraftChecksSchema,
}).loose();

export const KbDraftDetailSchema = z
  .object({
    id: z.string(),
    knowledge_base_id: text,
    title: text,
    version: countSchema,
    status: z.enum(KB_DRAFT_STATUSES).catch("open"),
    pages: lenientArray(KbDraftPageChangeSchema),
    checks: KbDraftChecksSchema,
  })
  .loose();

export const KbMergeRequestCreatedSchema = z
  .object({
    id: z.string(),
    number: countSchema,
    knowledge_base_id: text,
    title: text,
    status: z.enum(KB_MR_STATUSES).catch("open"),
    draft_id: text,
    job_id: nullableId,
  })
  .loose();

export const EMPTY_KB_JOB_LIST: KbJob[] = [];

export function kbJobFallback(id = ""): KbJob {
  return {
    id,
    knowledge_base_id: "",
    name: "",
    starter: "custom",
    agent_id: "",
    agent_name: "",
    chat_session_id: "",
    draft_id: null,
    created_by: "",
    state: "idle",
    last_reply: "",
    draft: null,
    merge_request: null,
    annotation_ids: [],
    page_id: null,
    created_at: "",
    updated_at: "",
  };
}

export function kbJobDetailFallback(id = ""): KbJobDetail {
  return { ...kbJobFallback(id), pages: [], checks: { lint: [], conflicts: [] } };
}

export function kbDraftDetailFallback(id = ""): KbDraftDetail {
  return { id, knowledge_base_id: "", title: "", version: 0, status: "open", pages: [], checks: { lint: [], conflicts: [] } };
}

export const EMPTY_KB_MERGE_REQUEST_CREATED: KbMergeRequestCreated = {
  id: "",
  number: 0,
  knowledge_base_id: "",
  title: "",
  status: "open",
  draft_id: "",
  job_id: null,
};

// Review: merge requests and their comments.

const KB_ORIGIN_TYPES = [
  "kb_job",
  "revert",
  "autopilot_run",
  "issue",
  "chat",
  "none",
] as const satisfies readonly KbMergeRequestOriginType[];

const nullableCount = z
  .number()
  .nullable()
  .optional()
  .catch(null)
  .transform((v) => v ?? null);

const KbMergeRequestOriginSchema = z
  .object({
    // An origin this client does not know shows as none: author only.
    type: z.enum(KB_ORIGIN_TYPES).catch("none"),
    label: text,
    ref_id: nullableId,
    // Servers before this field link every origin.
    openable: z.boolean().catch(true).default(true),
  })
  .loose();

const NO_ORIGIN = { type: "none", label: "", ref_id: null, openable: false } as const;

export const KbMergeRequestSchema = z
  .object({
    id: z.string(),
    number: countSchema,
    knowledge_base_id: text,
    title: text,
    summary: text,
    source: text,
    status: z.enum(KB_MR_STATUSES).catch("open"),
    risk: text,
    author_type: text,
    author_id: text,
    author_name: text,
    draft_id: text,
    draft_version: countSchema,
    annotation_ids: z
      .array(z.unknown())
      .nullable()
      .optional()
      .catch([])
      .transform((items) => (items ?? []).filter((item): item is string => typeof item === "string")),
    origin: KbMergeRequestOriginSchema.nullable()
      .optional()
      .catch(null)
      .transform((v) => v ?? { ...NO_ORIGIN }),
    job_id: nullableId,
    reverts: nullableCount,
    merged_by: nullableId,
    merged_by_name: text,
    merged_at: nullableId,
    closed_by: nullableId,
    closed_by_name: text,
    closed_at: nullableId,
    close_reason: text,
    review_requested_at: nullableId,
    created_at: text,
    updated_at: text,
    mention: text,
  })
  .loose();

export const KbMrReviewSchema = z
  .object({
    id: z.string(),
    merge_request_id: text,
    reviewer_user_id: text,
    reviewer_name: text,
    // A state this client does not know counts as submitted: shown, not editable.
    state: z.enum(KB_MR_REVIEW_STATES).catch("submitted"),
    summary: text,
    comment_count: countSchema,
    created_at: text,
    submitted_at: nullableId,
  })
  .loose();

export const KbMrReviewListSchema = lenientArray(KbMrReviewSchema);

export const KbMergeRequestListSchema = lenientArray(KbMergeRequestSchema);

export const KbMergeRequestDetailSchema = KbMergeRequestSchema.extend({
  knowledge_base_slug: text,
  knowledge_base_name: text,
  pages: lenientArray(KbDraftPageChangeSchema),
  checks: KbDraftChecksSchema,
  agent_running: flag,
  owner_id: text,
  owner_name: text,
  reviews: lenientArray(KbMrReviewSchema),
  pending_review: nullableObject(KbMrReviewSchema),
  can_merge: flag,
  can_close: flag,
  can_revert: flag,
  can_review: flag,
  can_request_review: flag,
}).loose();

const KbMrCommentQuoteSchema = z.object({ page_id: text, block_id: text, text: text }).loose();

export const KbMrCommentSchema = z
  .object({
    id: z.string(),
    merge_request_id: text,
    parent_id: nullableId,
    quote: nullableObject(KbMrCommentQuoteSchema),
    body: text,
    author_type: text,
    author_id: text,
    author_name: text,
    review_id: nullableId,
    // A state this client does not know shows as published: read-only.
    state: z.enum(["pending", "published"]).catch("published"),
    created_at: text,
  })
  .loose();

export const KbMrCommentListSchema = lenientArray(KbMrCommentSchema);

const KbMrEventSchema = z
  .object({
    id: z.string(),
    kind: z.enum(KB_MR_EVENT_KINDS).catch("unknown"),
    actor_type: text,
    actor_id: text,
    actor_name: text,
    payload: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .catch({})
      .transform((v) => v ?? {}),
    created_at: text,
  })
  .loose();

// An entry of a type this client does not know, or without an id, is dropped.
const KbMrTimelineEntrySchema = z.union([
  KbMrCommentSchema.extend({ type: z.literal("comment") }),
  KbMrEventSchema.extend({ type: z.literal("event") }),
]);

export const KbMrTimelineSchema = lenientArray(KbMrTimelineEntrySchema);

export const KbMrHandoffSchema = z
  .object({ chat_session_id: text, message_id: text, task_id: text })
  .loose();

export const EMPTY_KB_MR_REVIEW_LIST: KbMrReview[] = [];
export const EMPTY_KB_MR_TIMELINE: KbMrTimelineEntry[] = [];
export const EMPTY_KB_MR_HANDOFF: KbMrHandoff = { chat_session_id: "", message_id: "", task_id: "" };

export function kbMrReviewFallback(id = ""): KbMrReview {
  return {
    id,
    merge_request_id: "",
    reviewer_user_id: "",
    reviewer_name: "",
    state: "submitted",
    summary: "",
    comment_count: 0,
    created_at: "",
    submitted_at: null,
  };
}

export const EMPTY_KB_MERGE_REQUEST_LIST: KbMergeRequest[] = [];
export const EMPTY_KB_MR_COMMENT_LIST: KbMrComment[] = [];

export function kbMergeRequestFallback(id = ""): KbMergeRequest {
  return {
    id,
    number: 0,
    knowledge_base_id: "",
    title: "",
    summary: "",
    source: "",
    status: "open",
    risk: "",
    author_type: "",
    author_id: "",
    author_name: "",
    draft_id: "",
    draft_version: 0,
    annotation_ids: [],
    origin: { ...NO_ORIGIN },
    job_id: null,
    reverts: null,
    merged_by: null,
    merged_by_name: "",
    merged_at: null,
    closed_by: null,
    closed_by_name: "",
    closed_at: null,
    close_reason: "",
    review_requested_at: null,
    created_at: "",
    updated_at: "",
    mention: "",
  };
}

/** What a broken detail response degrades to: nothing the viewer can act on. */
export function kbMergeRequestDetailFallback(id = ""): KbMergeRequestDetail {
  return {
    ...kbMergeRequestFallback(id),
    knowledge_base_slug: "",
    knowledge_base_name: "",
    pages: [],
    checks: { lint: [], conflicts: [] },
    agent_running: false,
    owner_id: "",
    owner_name: "",
    reviews: [],
    pending_review: null,
    can_merge: false,
    can_close: false,
    can_revert: false,
    can_review: false,
    can_request_review: false,
  };
}

export function kbMrCommentFallback(id = ""): KbMrComment {
  return {
    id,
    merge_request_id: "",
    parent_id: null,
    quote: null,
    body: "",
    author_type: "",
    author_id: "",
    author_name: "",
    review_id: null,
    state: "published",
    created_at: "",
  };
}

// Knowledge base management: raw files, the relationship graph, deletion.

const KB_RAW_KINDS = ["source", "asset"] as const;

const KbRawFileItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(KB_RAW_KINDS).catch("source"),
    name: text,
    uri: text,
    content_type: text,
    size: countSchema,
    uploaded_by: text,
    uploaded_by_name: text,
    created_at: text,
    cited_pages: countSchema,
  })
  .loose();

export const KbRawFileListSchema = lenientArray(KbRawFileItemSchema);

const KbStalePageSchema = z
  .object({
    page_id: z.string(),
    path: text,
    title: text,
    stale_after: text,
    claims: countSchema,
  })
  .loose();

export const KbStalePageListSchema = lenientArray(KbStalePageSchema);

export const EMPTY_KB_STALE_PAGE_LIST: KbStalePage[] = [];

export const EMPTY_KB_RAW_FILE_LIST: KbRawFileItem[] = [];

const KbRawUploadedFileSchema = z
  .object({
    id: z.string(),
    kind: z.enum(KB_RAW_KINDS).catch("source"),
    name: text,
    uri: text,
    size: countSchema,
  })
  .loose();

export const KbRawUploadSchema = z
  .object({ files: lenientArray(KbRawUploadedFileSchema) })
  .loose()
  .transform((v): KbRawUploadedFile[] => v.files);

export const EMPTY_KB_RAW_UPLOAD: KbRawUploadedFile[] = [];

export const KbRawContentURLSchema = z.object({ url: text }).loose();

const KbGraphNodeSchema = z
  .object({
    key: z.string(),
    id: nullableId,
    title: text,
    path: text,
    group: text,
    degree: countSchema,
    missing: flag,
  })
  .loose();

const KbGraphEdgeSchema = z.object({ from: z.string(), to: z.string() }).loose();

export const KbGraphSchema = z
  .object({
    nodes: lenientArray(KbGraphNodeSchema),
    edges: lenientArray(KbGraphEdgeSchema),
  })
  .loose()
  .transform((graph): KbGraph => {
    // An edge to a node the response left out has nothing to draw.
    const keys = new Set(graph.nodes.map((node) => node.key));
    return { nodes: graph.nodes, edges: graph.edges.filter((edge) => keys.has(edge.from) && keys.has(edge.to)) };
  });

export const EMPTY_KB_GRAPH: KbGraph = { nodes: [], edges: [] };

export const KbDeleteResultSchema = z
  .object({
    deleted: flag,
    closed_mrs: lenientArray(z.number()),
  })
  .loose();

/** A delete that answered 2xx removed the knowledge base, whatever the body says. */
export const KB_DELETE_RESULT_FALLBACK: KbDeleteResult = { deleted: true, closed_mrs: [] };
