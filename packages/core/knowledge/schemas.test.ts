// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  EMPTY_KNOWLEDGE_BASE,
  EMPTY_KNOWLEDGE_DELETE_IMPACT,
  KnowledgeBaseListSchema,
  KnowledgeBaseSchema,
  KnowledgeDeleteImpactSchema,
} from "./schemas";

const opts = { endpoint: "test" };

describe("knowledge schemas", () => {
  it("fills defaults for a sparse knowledge base", () => {
    const kb = parseWithFallback({ id: "kb-1", name: "团队知识库" }, KnowledgeBaseSchema, EMPTY_KNOWLEDGE_BASE, opts);
    expect(kb).toMatchObject({ id: "kb-1", name: "团队知识库", slug: "", page_count: 0, maintainer_agent_id: null });
  });

  it("falls back when the knowledge base has no id", () => {
    expect(parseWithFallback({ name: 1 }, KnowledgeBaseSchema, EMPTY_KNOWLEDGE_BASE, opts)).toEqual(EMPTY_KNOWLEDGE_BASE);
  });

  it("turns a malformed list into an empty list", () => {
    expect(parseWithFallback({ bases: [] }, KnowledgeBaseListSchema, [], opts)).toEqual([]);
  });

  it("defaults a malformed delete impact", () => {
    expect(parseWithFallback("nope", KnowledgeDeleteImpactSchema, EMPTY_KNOWLEDGE_DELETE_IMPACT, opts)).toEqual(
      EMPTY_KNOWLEDGE_DELETE_IMPACT,
    );
  });
});
