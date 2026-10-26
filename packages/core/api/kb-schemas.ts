import { z } from "zod";
import type {
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
