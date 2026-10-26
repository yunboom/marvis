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
  /** Visible pages; excludes the reserved quickstart page and deleted pages. */
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
  /** "" for ordinary pages, "quickstart" for the home body. */
  reserved: string;
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
  reserved: string;
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
  quickstart: KbPage | null;
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
