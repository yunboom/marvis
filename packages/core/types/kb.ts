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
