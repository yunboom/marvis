/** How a knowledge base's page schema is defined. */
export type KnowledgeBaseSchemaMode = "default" | "custom";

/** Work waiting on people in a knowledge base. */
export interface KnowledgeBasePending {
  /** Open annotations on pages. */
  annotations: number;
  /** Pages flagged for re-review because their sources changed. */
  stale_pages: number;
  /** Merge requests waiting for review. */
  open_mrs: number;
}

/** A knowledge base as returned by the list endpoint. */
export interface KnowledgeBase {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string;
  /**
   * Usually a {@link KnowledgeBaseSchemaMode}; widened to string so a mode
   * added by a newer backend still type-checks at the boundary.
   */
  schema_mode: KnowledgeBaseSchemaMode | (string & {});
  created_by: string;
  /** Live pages; deleted pages are not counted. */
  page_count: number;
  content_version: number;
  created_at: string;
  updated_at: string;
  pending: KnowledgeBasePending;
}

/** A single knowledge base with its purpose and schema text. */
export interface KnowledgeBaseDetail extends KnowledgeBase {
  purpose: string;
  schema: string;
}

/** What a draft did to a page; empty when no draft applies. */
export type KbDraftChange = "added" | "modified" | "moved" | "deleted" | "";

/** A page referenced by another page: a breadcrumb entry or a backlink. */
export interface KbPageRef {
  id: string;
  title: string;
}

/** One body block: a Markdown fragment whose page links are app routes. */
export interface KbBlock {
  id: string;
  kind: string;
  content: string;
}

/** The uploaded file behind a raw:// source. */
export interface KbRawFile {
  id: string;
  name: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  created_at: string;
  /** Cited PDF page; 0 when none. */
  page: number;
}

/** A cited source of a page, generated from its claims. */
export interface KbSource {
  /** Footnote id the body cites as `[^id]`. */
  id: string;
  /** task / chat / pr / repo / raw / web / other. */
  kind: string;
  uri: string;
  title: string;
  version: string;
  /** Whether the current user can open it. */
  openable: boolean;
  raw: KbRawFile | null;
}

/** Where a claim sits on the page. */
export interface KbClaim {
  key: string;
  block_id: string;
  text: string;
  checked_at: string;
}

/** The merge that produced a page's current revision. */
export interface KbLastMerge {
  number: number;
  author_type: string;
  author_id: string;
  author_name: string;
  merged_at: string;
}

/** A merge request named next to a page. */
export interface KbMergeRequestRef {
  number: number;
  title: string;
}

/** Where a draft was started. */
export interface KbDraftOrigin {
  /** kb_job / chat / issue / none. */
  type: string;
  label: string;
  ref_id: string;
}

/** One of the current user's live drafts that change a page. */
export interface KbPageDraft {
  id: string;
  title: string;
  status: string;
  updated_at: string;
  draft_change: string;
  changed_blocks: number;
  origin: KbDraftOrigin;
}

/** A page as the reading page shows it. */
export interface KbPage {
  id: string;
  knowledge_base_id: string;
  path: string;
  /** Revision id, or d<version> when read from a draft. */
  version: string;
  breadcrumb: KbPageRef[];
  frontmatter: Record<string, unknown>;
  blocks: KbBlock[];
  sources: KbSource[];
  claims: KbClaim[];
  last_mr: KbLastMerge | null;
  updated_at: string;
  stale: boolean;
  backlinks: KbPageRef[];
  pending_mr: KbMergeRequestRef | null;
  pending_mr_count: number;
  annotations_open: number;
  /** A {@link KbDraftChange}, widened so a newer backend still parses. */
  draft_change: string;
  drafts: KbPageDraft[];
}

/** One page of a page tree level. */
export interface KbTreePage {
  id: string;
  path: string;
  title: string;
  type: string;
  description: string;
  has_child: boolean;
  child_count: number;
  stale: boolean;
  open_annotations: number;
  draft_change: string;
}

/** The page whose children a tree level lists. */
export interface KbTreeParent {
  id: string;
  path: string;
  title: string;
}

/** One cursor page of a page tree level. */
export interface KbTreeLevel {
  version: number;
  parent: KbTreeParent | null;
  pages: KbTreePage[];
  /** Empty when the level is complete. */
  next_cursor: string;
  /** Pages on the whole level (of the requested type), across all cursor pages. */
  total: number;
}

/** Pending work counts on the home page. */
export interface KbHomePending {
  annotations: number;
  agent_reported: number;
  stale_pages: number;
  open_mrs: number;
  latest_mr: KbMergeRequestRef | null;
}

/** A page changed by a recent merge. */
export interface KbRecentPage {
  page_id: string;
  path: string;
  title: string;
  mr_number: number;
  mr_title: string;
  merged_at: string;
}

/** The knowledge base home page. */
export interface KbHome {
  knowledge_base: KnowledgeBase;
  pending: KbHomePending;
  recent: KbRecentPage[];
  running_jobs: number;
}

/** One entry of a page's history. */
export interface KbRevision {
  revision_id: string;
  /** Null for the initial revision written at creation. */
  mr_number: number | null;
  mr_title: string;
  source: string;
  author_type: string;
  author_id: string;
  author_name: string;
  merged_by: string;
  merged_by_name: string;
  merged_at: string;
  annotations: number;
  added: number;
  deleted: number;
  current: boolean;
}

/** One line of a revision diff: equal / added / deleted. */
export interface KbDiffLine {
  op: string;
  old_line: number;
  new_line: number;
  text: string;
}

/** A run of changes with context, titled by the heading above it. */
export interface KbDiffHunk {
  heading: string;
  lines: KbDiffLine[];
}

/** A revision compared with the revision before it. */
export interface KbRevisionDiff {
  revision: KbRevision;
  prev_revision_id: string;
  hunks: KbDiffHunk[];
}

/** What a knowledge base builder conversation works on. */
export type KbBuilderMode = "create" | "config";

/**
 * The right-hand configuration of a builder conversation as stored on the
 * server (opaque there). `schema` matters only in the custom schema mode.
 */
export interface StoredKbDraft {
  name: string;
  slug: string;
  description: string;
  purpose: string;
  schema_mode: KnowledgeBaseSchemaMode;
  schema: string;
  /** The last builder reply already applied to the form. */
  applied_message_id: string | null;
}

/** One unfinished builder conversation. */
export interface KbBuilderSession {
  session_id: string;
  mode: KbBuilderMode | (string & {});
  /** The configured knowledge base; null when creating. */
  knowledge_base_id: string | null;
  title: string;
  /** Where the carrier runs, i.e. where the next message is answered. */
  runtime_id: string;
  /** Raw stored message in the builder wire format. */
  last_message_content: string;
  last_message_role: string;
  last_message_at: string | null;
  /** Saved configuration; null when never saved. */
  draft: StoredKbDraft | null;
  updated_at: string;
}

/** A started builder conversation. */
export interface KbBuilderSessionStart {
  session_id: string;
  builder_agent_id: string;
  runtime_id: string;
}

export interface CreateKbBuilderSessionRequest {
  mode: KbBuilderMode;
  knowledge_base_id?: string;
  schema_mode: KnowledgeBaseSchemaMode;
  runtime_id: string;
  model?: string;
}

export interface CreateKnowledgeBaseRequest {
  name: string;
  slug: string;
  description: string;
  purpose: string;
  schema_mode: KnowledgeBaseSchemaMode;
  /** Only (and then required) in the custom schema mode. */
  schema?: string;
}

export interface UpdateKnowledgeBaseRequest {
  name?: string;
  description?: string;
  purpose?: string;
  schema_mode?: KnowledgeBaseSchemaMode;
  /** Only when the effective schema mode is custom. */
  schema?: string;
  /** The updated_at the editor opened; a newer save answers 409. */
  base_updated_at?: string;
}

/** The built-in texts the configuration form shows. */
export interface KbTemplates {
  default_schema: string;
  purpose_template: string;
}

/** A created or updated knowledge base, with its mention Markdown. */
export interface KnowledgeBaseMutation extends KnowledgeBase {
  mention: string;
}

/** Status of an annotation (spec 7.6). */
export type KbAnnotationStatus = "pending" | "processing" | "resolved" | "dismissed";

/** Status filter of the annotation list; `all` lists every status. */
export type KbAnnotationStatusFilter = KbAnnotationStatus | "all";

/**
 * A note on a sentence, a page or a whole knowledge base. `page_id` null is
 * the whole knowledge base; an empty `block_id` on a page is the whole page.
 */
export interface KbAnnotation {
  id: string;
  knowledge_base_id: string;
  page_id: string | null;
  page_path: string;
  page_title: string;
  block_id: string;
  /** 1-based position of the block on the page, 0 when not on a block. */
  block_index: number;
  /** The sentence as it reads now. */
  quote: string;
  /** The sentence when annotated, once a merge reworded it; empty otherwise. */
  original_quote: string;
  prefix: string;
  suffix: string;
  body: string;
  author_type: "member" | "agent";
  author_id: string;
  author_name: string;
  status: KbAnnotationStatus;
  /** The sentence is gone; the annotation now reads as one on the page. */
  anchor_lost: boolean;
  merge_request_id: string | null;
  mr_number: number | null;
  created_at: string;
  updated_at: string;
  mention: string;
}

export interface CreateKbAnnotationRequest {
  /** Omitted for an annotation on the whole knowledge base. */
  page_id?: string;
  /** With `quote`, the sentence's block. */
  block_id?: string;
  quote?: string;
  prefix?: string;
  suffix?: string;
  body: string;
}

/** How a search ran: `hybrid` fused keyword and vector hits, `keyword` used keywords only. */
export type KbSearchMode = "hybrid" | "keyword";

/** A page a search found, with its best-matching block. */
export interface KbSearchHit {
  page_id: string;
  /** Knowledge base slug. */
  slug: string;
  path: string;
  /** Titles of the pages above, top level first. */
  parents: string[];
  title: string;
  type: string;
  /** Empty when only the title matched. */
  block_id: string;
  excerpt: string;
  /** RRF score; only meaningful for ordering. */
  score: number;
  mention: string;
}

export interface KbSearchResult {
  mode: KbSearchMode;
  /** Pages found, beyond the hits returned. */
  total: number;
  hits: KbSearchHit[];
}

export interface KbSearchParams {
  q: string;
  /** Knowledge base id or slug; every knowledge base when omitted. */
  kb?: string;
  type?: string;
  /** 1-50; the server defaults to 10. */
  limit?: number;
}

/** The opener a knowledge base job was started from (spec 7.10). */
export type KbJobStarter =
  | "ingest"
  | "health"
  | "merge"
  | "annotations"
  | "new_page"
  | "schedule"
  | "custom";

/** Read off the job's chat: its latest agent turn. */
export type KbJobState = "running" | "idle" | "failed" | "stopped";

/** Draft statuses (kb_draft.status). */
export type KbDraftStatus = "open" | "submitted" | "merged" | "discarded";

/** Merge request statuses. */
export type KbMergeRequestStatus = "open" | "merged" | "closed";

/** The linked draft at a glance; added / deleted are only counted on the detail. */
export interface KbJobDraft {
  version: number;
  status: KbDraftStatus;
  pages: number;
  added: number;
  deleted: number;
}

/** The latest merge request made from the job's draft. */
export interface KbJobMergeRequest {
  id: string;
  number: number;
  title: string;
  status: KbMergeRequestStatus;
  author_type: string;
  author_id: string;
  author_name: string;
  merged_by_name: string;
  closed_by_name: string;
  close_reason: string;
}

/** A knowledge base job: a chat with an agent that writes one draft. */
export interface KbJob {
  id: string;
  knowledge_base_id: string;
  name: string;
  starter: KbJobStarter;
  agent_id: string;
  agent_name: string;
  chat_session_id: string;
  /** Null until the agent creates the job's draft. */
  draft_id: string | null;
  created_by: string;
  state: KbJobState;
  last_reply: string;
  draft: KbJobDraft | null;
  merge_request: KbJobMergeRequest | null;
  annotation_ids: string[];
  page_id: string | null;
  created_at: string;
  updated_at: string;
}

/** One line of a changed page's diff. */
export interface KbDraftDiffLine {
  kind: "context" | "add" | "delete";
  text: string;
  block_id: string;
  old_line: number;
  new_line: number;
}

/** One changed page of a draft: a file card. */
export interface KbDraftPageChange {
  page_id: string;
  path: string;
  old_path: string;
  title: string;
  change: KbDraftChange;
  added: number;
  deleted: number;
  lines: KbDraftDiffLine[];
}

/** A format check finding. */
export interface KbLintFinding {
  code: string;
  severity: "error" | "warning";
  page_id: string;
  path: string;
  block_id: string;
  message: string;
}

/** An unresolved conflict with the mainline. */
export interface KbDraftConflict {
  page_id: string;
  path: string;
  kind: string;
  block_id: string;
  main_lines: string;
  draft_lines: string;
}

/** A job with its draft's changes and checks. */
export interface KbJobDetail extends KbJob {
  pages: KbDraftPageChange[];
  checks: { lint: KbLintFinding[]; conflicts: KbDraftConflict[] };
}

export interface CreateKbJobRequest {
  agent_id: string;
  starter: KbJobStarter;
  name?: string;
  message: string;
  annotation_ids?: string[];
  page_id?: string | null;
  sources?: string[];
}

/** A merge request as created by a job submit. */
export interface KbMergeRequestCreated {
  id: string;
  number: number;
  knowledge_base_id: string;
  title: string;
  status: KbMergeRequestStatus;
  draft_id: string;
  job_id: string | null;
}

/** Where a merge request came from (spec 7.13), in the order it is decided. */
export type KbMergeRequestOriginType = "kb_job" | "revert" | "autopilot_run" | "issue" | "chat" | "none";

export interface KbMergeRequestOrigin {
  type: KbMergeRequestOriginType;
  /** The origin's own name (job, reverted request, autopilot, issue or chat). */
  label: string;
  /** What to open: the job, reverted request, autopilot, issue or chat id. */
  ref_id: string | null;
}

/** A merge request: one draft under review. */
export interface KbMergeRequest {
  id: string;
  number: number;
  knowledge_base_id: string;
  title: string;
  summary: string;
  source: string;
  status: KbMergeRequestStatus;
  risk: string;
  author_type: string;
  author_id: string;
  author_name: string;
  draft_id: string;
  /** The draft version to merge with; the server refuses a newer draft. */
  draft_version: number;
  annotation_ids: string[];
  origin: KbMergeRequestOrigin;
  job_id: string | null;
  /** The number of the request this one reverts. */
  reverts: number | null;
  merged_by: string | null;
  merged_by_name: string;
  merged_at: string | null;
  closed_by: string | null;
  closed_by_name: string;
  closed_at: string | null;
  close_reason: string;
  created_at: string;
  updated_at: string;
  mention: string;
}

/** A merge request with its file cards, checks and what the viewer may do. */
export interface KbMergeRequestDetail extends KbMergeRequest {
  knowledge_base_slug: string;
  knowledge_base_name: string;
  pages: KbDraftPageChange[];
  checks: { lint: KbLintFinding[]; conflicts: KbDraftConflict[] };
  /** The agent a plain review comment goes to; null when no agent stands behind it. */
  review_agent: { id: string; name: string } | null;
  /** The job's agent, or one a comment started, is still working. */
  agent_running: boolean;
  can_merge: boolean;
  can_close: boolean;
  can_revert: boolean;
}

/** Review list filters; "merged,closed" is every ended request. */
export type KbMergeRequestListStatus = KbMergeRequestStatus | "all" | "merged,closed";

/** The diff line a review comment quotes. */
export interface KbMrCommentQuote {
  page_id: string;
  block_id: string;
  text: string;
}

/** An agent a review comment started. */
export interface KbMrCommentTrigger {
  agent_id: string;
  agent_name: string;
  /** author: the request's agent picked it up; mention: it was @-named. */
  reason: string;
  chat_session_id: string | null;
  task_id: string | null;
  running: boolean;
}

/** A review comment. */
export interface KbMrComment {
  id: string;
  merge_request_id: string;
  parent_id: string | null;
  quote: KbMrCommentQuote | null;
  body: string;
  author_type: string;
  author_id: string;
  author_name: string;
  triggered: KbMrCommentTrigger[];
  created_at: string;
}

export interface CreateKbMrCommentRequest {
  body: string;
  parent_id?: string | null;
  quote?: KbMrCommentQuote | null;
}

/** Kinds of raw files: uploaded source documents and images pages embed. */
export type KbRawKind = "source" | "asset";

/** A row of the raw files tab. */
export interface KbRawFileItem {
  id: string;
  kind: KbRawKind;
  name: string;
  /** Address pages cite it by: raw://sources/<name>. */
  uri: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  uploaded_by_name: string;
  created_at: string;
  /** Live pages whose claims cite the file. */
  cited_pages: number;
}

/** A file an upload wrote. */
export interface KbRawUploadedFile {
  id: string;
  kind: KbRawKind;
  name: string;
  uri: string;
  size: number;
}

/** A page of the relationship graph, or a linked page not yet written. */
export interface KbGraphNode {
  /** What edges reference: the page id, or the path of a missing page. */
  key: string;
  /** Null for a page not yet written. */
  id: string | null;
  title: string;
  path: string;
  /** Title of the top-level page it sits under; decides its color. */
  group: string;
  degree: number;
  missing: boolean;
}

export interface KbGraphEdge {
  from: string;
  to: string;
}

export interface KbGraph {
  nodes: KbGraphNode[];
  edges: KbGraphEdge[];
}

/** What deleting a knowledge base removed. */
export interface KbDeleteResult {
  deleted: boolean;
  /** Numbers of the open merge requests deleted with it. */
  closed_mrs: number[];
}
