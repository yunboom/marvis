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
