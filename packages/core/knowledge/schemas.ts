import { z } from "zod";

// Knowledge base wire shapes (server/internal/handler/knowledge*.go). Every
// field the UI reads has a default so an older or partial backend response
// degrades to an empty value instead of failing the whole page.

export const KnowledgeBaseSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string().optional().default(""),
    name: z.string().optional().default(""),
    slug: z.string().optional().default(""),
    description: z.string().optional().default(""),
    maintainer_agent_id: z.string().nullable().optional().default(null),
    created_by: z.string().optional().default(""),
    page_count: z.number().optional().default(0),
    created_at: z.string().optional().default(""),
    updated_at: z.string().optional().default(""),
  })
  .loose();

export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const EMPTY_KNOWLEDGE_BASE: KnowledgeBase = {
  id: "",
  workspace_id: "",
  name: "",
  slug: "",
  description: "",
  maintainer_agent_id: null,
  created_by: "",
  page_count: 0,
  created_at: "",
  updated_at: "",
};

export const KnowledgeBaseListSchema = z.array(KnowledgeBaseSchema).catch([]);

export const KnowledgeDeleteImpactSchema = z
  .object({
    open_annotations: z.number().optional().default(0),
    open_change_requests: z.number().optional().default(0),
    last_knowledge_base: z.boolean().optional().default(false),
  })
  .loose();

export type KnowledgeDeleteImpact = z.infer<typeof KnowledgeDeleteImpactSchema>;

export const EMPTY_KNOWLEDGE_DELETE_IMPACT: KnowledgeDeleteImpact = {
  open_annotations: 0,
  open_change_requests: 0,
  last_knowledge_base: false,
};

export interface CreateKnowledgeBaseRequest {
  name: string;
  slug?: string;
  description?: string;
  purpose?: string;
  maintainer_agent_id?: string | null;
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  maintainer_agent_id?: string | null;
}

export const KNOWLEDGE_PAGE_GROUPS = ["entities", "concepts", "howtos", "decisions", "syntheses", "sources", "queries"] as const;
export type KnowledgePageGroup = (typeof KNOWLEDGE_PAGE_GROUPS)[number];

export const KNOWLEDGE_DOMAINS = ["dev", "qa", "product"] as const;
export type KnowledgeDomain = (typeof KNOWLEDGE_DOMAINS)[number];

const stringList = z
  .array(z.string())
  .nullable()
  .catch([])
  .transform((v) => v ?? []);

export const KnowledgePageSummarySchema = z
  .object({
    path: z.string(),
    group: z.string().optional().default(""),
    title: z.string().optional().default(""),
    type: z.string().optional().default(""),
    domains: stringList,
    verified: z.boolean().optional().default(false),
    needs_check: z.boolean().optional().default(false),
    open_annotations: z.number().optional().default(0),
    agent_findings: z.number().optional().default(0),
  })
  .loose();
export type KnowledgePageSummary = z.infer<typeof KnowledgePageSummarySchema>;

export const KnowledgePageListSchema = z
  .object({
    commit: z.string().optional().default(""),
    pages: z.array(KnowledgePageSummarySchema).catch([]),
  })
  .loose();
export type KnowledgePageList = z.infer<typeof KnowledgePageListSchema>;
export const EMPTY_KNOWLEDGE_PAGE_LIST: KnowledgePageList = { commit: "", pages: [] };

const SentenceSchema = z.object({
  text: z.string().optional().default(""),
  cites: z
    .array(z.number())
    .nullable()
    .catch([])
    .transform((v) => v ?? []),
});
export type KnowledgeSentence = z.infer<typeof SentenceSchema>;

const SectionSchema = z.object({
  heading: z.string().optional().default(""),
  paragraphs: z
    .array(z.array(SentenceSchema))
    .nullable()
    .catch([])
    .transform((v) => v ?? []),
});
export type KnowledgeSection = z.infer<typeof SectionSchema>;

export const KnowledgeSourceSchema = z
  .object({
    n: z.number(),
    kind: z.string().optional().default("text"),
    uri: z.string().optional().default(""),
    label: z.string().optional().default(""),
    chat: z
      .object({
        owner_name: z.string().optional().default(""),
        agent_name: z.string().optional().default(""),
        created_at: z.string().optional().default(""),
        openable: z.boolean().optional().default(false),
        session_id: z.string().optional(),
      })
      .nullable()
      .optional()
      .default(null),
  })
  .loose();
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

const FrontMatterSchema = z
  .object({
    type: z.string().optional().default(""),
    description: z.string().optional().default(""),
    domains: stringList,
    verified: z
      .object({ by: z.string().optional().default(""), at: z.string().optional().default("") })
      .nullable()
      .catch(null),
    status: z.string().optional().default(""),
    stale_after: z.string().optional().default(""),
  })
  .loose();

export const KnowledgePageSchema = z
  .object({
    commit: z.string().optional().default(""),
    path: z.string(),
    group: z.string().optional().default(""),
    title: z.string().optional().default(""),
    front_matter: FrontMatterSchema.catch({ type: "", description: "", domains: [], verified: null, status: "", stale_after: "" }),
    needs_check: z.boolean().optional().default(false),
    sections: z
      .array(SectionSchema)
      .nullable()
      .catch([])
      .transform((v) => v ?? []),
    sources: z
      .array(KnowledgeSourceSchema)
      .nullable()
      .catch([])
      .transform((v) => v ?? []),
    backlinks: z
      .array(z.object({ path: z.string(), title: z.string().optional().default("") }))
      .nullable()
      .catch([])
      .transform((v) => v ?? []),
    markdown: z.string().optional().default(""),
  })
  .loose();
export type KnowledgePage = z.infer<typeof KnowledgePageSchema>;

export const KnowledgeSearchHitSchema = z
  .object({
    path: z.string(),
    slug: z.string().optional().default(""),
    title: z.string().optional().default(""),
    excerpt: z.string().optional().default(""),
  })
  .loose();
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHitSchema>;

export const KNOWLEDGE_GAP_STATUSES = ["open", "processing", "filled"] as const;
export type KnowledgeGapStatus = (typeof KNOWLEDGE_GAP_STATUSES)[number];

export const KnowledgeGapSchema = z
  .object({
    id: z.string(),
    question: z.string().optional().default(""),
    source: z.string().optional().default(""),
    status: z.enum(KNOWLEDGE_GAP_STATUSES).catch("open"),
    created_at: z.string().optional().default(""),
  })
  .loose();
export type KnowledgeGap = z.infer<typeof KnowledgeGapSchema>;
export const KnowledgeGapListSchema = z.array(KnowledgeGapSchema).catch([]);

export const KnowledgeSearchSchema = z
  .object({
    hits: z
      .array(KnowledgeSearchHitSchema)
      .nullable()
      .catch([])
      .transform((v) => v ?? []),
    gap: KnowledgeGapSchema.nullable().optional().default(null),
  })
  .loose();
export type KnowledgeSearchResult = z.infer<typeof KnowledgeSearchSchema>;
export const EMPTY_KNOWLEDGE_SEARCH: KnowledgeSearchResult = { hits: [], gap: null };

export const KnowledgeGraphSchema = z
  .object({
    nodes: z
      .array(
        z.object({
          path: z.string(),
          title: z.string().optional().default(""),
          group: z.string().optional().default(""),
          degree: z.number().optional().default(0),
        }),
      )
      .catch([]),
    edges: z.array(z.object({ from: z.string(), to: z.string() })).catch([]),
  })
  .loose();
export type KnowledgeGraph = z.infer<typeof KnowledgeGraphSchema>;
export const EMPTY_KNOWLEDGE_GRAPH: KnowledgeGraph = { nodes: [], edges: [] };

export const KNOWLEDGE_ANNOTATION_STATUSES = ["pending", "processing", "resolved", "dismissed"] as const;
export type KnowledgeAnnotationStatus = (typeof KNOWLEDGE_ANNOTATION_STATUSES)[number];

export const KnowledgeAnnotationSchema = z
  .object({
    id: z.string(),
    knowledge_base_id: z.string().optional().default(""),
    page_path: z.string().optional().default(""),
    page_title: z.string().optional().default(""),
    quote: z.string().optional().default(""),
    body: z.string().optional().default(""),
    author_type: z.string().optional().default("member"),
    author_id: z.string().optional().default(""),
    author_name: z.string().optional().default(""),
    status: z.enum(KNOWLEDGE_ANNOTATION_STATUSES).catch("pending"),
    change_request_id: z.string().nullable().optional().default(null),
    change_number: z.number().nullable().optional().default(null),
    anchor_lost: z.boolean().optional().default(false),
    created_at: z.string().optional().default(""),
  })
  .loose();
export type KnowledgeAnnotation = z.infer<typeof KnowledgeAnnotationSchema>;
export const KnowledgeAnnotationListSchema = z.array(KnowledgeAnnotationSchema).catch([]);

export const KNOWLEDGE_CHANGE_STATUSES = ["open", "merged", "closed"] as const;
export type KnowledgeChangeStatus = (typeof KNOWLEDGE_CHANGE_STATUSES)[number];

export const KNOWLEDGE_CHANGE_SOURCES = ["fix", "ingest", "fresh", "merge", "gap", "digest", "edit", "revert", "agent"] as const;
export type KnowledgeChangeSource = (typeof KNOWLEDGE_CHANGE_SOURCES)[number];

export const KNOWLEDGE_CHANGE_RISKS = ["low", "medium", "high"] as const;
export type KnowledgeChangeRisk = (typeof KNOWLEDGE_CHANGE_RISKS)[number];

export const KnowledgeChangeRequestSchema = z
  .object({
    id: z.string(),
    number: z.number(),
    title: z.string().optional().default(""),
    source: z.enum(KNOWLEDGE_CHANGE_SOURCES).catch("agent"),
    author_type: z.string().optional().default("member"),
    author_id: z.string().optional().default(""),
    author_name: z.string().optional().default(""),
    branch: z.string().optional().default(""),
    status: z.enum(KNOWLEDGE_CHANGE_STATUSES).catch("open"),
    conflict: z.boolean().optional().default(false),
    conflict_files: stringList,
    summary: z.string().optional().default(""),
    risk: z.enum(KNOWLEDGE_CHANGE_RISKS).catch("low"),
    merge_commit: z.string().nullable().optional().default(null),
    chat_session_id: z.string().nullable().optional().default(null),
    annotation_ids: stringList,
    kb_slugs: stringList,
    merged_at: z.string().nullable().optional().default(null),
    created_at: z.string().optional().default(""),
    updated_at: z.string().optional().default(""),
  })
  .loose();
export type KnowledgeChangeRequest = z.infer<typeof KnowledgeChangeRequestSchema>;
export const KnowledgeChangeRequestListSchema = z.array(KnowledgeChangeRequestSchema).catch([]);

const DiffLineSchema = z.object({
  kind: z.enum(["context", "add", "delete"]).catch("context"),
  text: z.string().optional().default(""),
  old_line: z.number().optional().default(0),
  new_line: z.number().optional().default(0),
});
export type KnowledgeDiffLine = z.infer<typeof DiffLineSchema>;

const FileDiffSchema = z.object({
  path: z.string(),
  status: z.string().optional().default("modified"),
  binary: z.boolean().optional().default(false),
  added: z.number().optional().default(0),
  deleted: z.number().optional().default(0),
  lines: z
    .array(DiffLineSchema)
    .nullable()
    .catch([])
    .transform((v) => v ?? []),
});
export type KnowledgeFileDiff = z.infer<typeof FileDiffSchema>;

export const KnowledgeChangeCommentSchema = z.object({
  id: z.string(),
  path: z.string(),
  line: z.number(),
  author_type: z.string().optional().default("member"),
  author_id: z.string().optional().default(""),
  body: z.string().optional().default(""),
  created_at: z.string().optional().default(""),
});
export type KnowledgeChangeComment = z.infer<typeof KnowledgeChangeCommentSchema>;

export const KnowledgeChangeDetailSchema = KnowledgeChangeRequestSchema.extend({
  groups: z
    .array(
      z.object({
        slug: z.string(),
        files: z
          .array(FileDiffSchema)
          .nullable()
          .catch([])
          .transform((v) => v ?? []),
      }),
    )
    .nullable()
    .catch([])
    .transform((v) => v ?? []),
  comments: z
    .array(KnowledgeChangeCommentSchema)
    .nullable()
    .catch([])
    .transform((v) => v ?? []),
}).loose();
export type KnowledgeChangeDetail = z.infer<typeof KnowledgeChangeDetailSchema>;
