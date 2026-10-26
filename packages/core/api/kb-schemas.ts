import { z } from "zod";
import type {
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
