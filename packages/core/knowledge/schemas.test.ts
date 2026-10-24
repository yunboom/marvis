// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "../api/schema";
import {
  EMPTY_KNOWLEDGE_BASE,
  EMPTY_KNOWLEDGE_DELETE_IMPACT,
  KnowledgeBaseListSchema,
  KnowledgeBaseSchema,
  KnowledgeChangeDetailSchema,
  KnowledgeDeleteImpactSchema,
  parseKnowledgeBaseDraft,
  stripKnowledgeBaseDraft,
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

  it("reads the latest complete knowledge base draft and strips draft blocks", () => {
    const reply =
      'First idea <kb_draft>{"name":"Old","description":"","purpose":""}</kb_draft>\nBetter: <kb_draft>{"name":"QA lab","description":"Test methods","purpose":"For testers"}</kb_draft>';
    expect(parseKnowledgeBaseDraft(reply)).toEqual({ name: "QA lab", description: "Test methods", purpose: "For testers" });
    expect(stripKnowledgeBaseDraft(reply)).toBe("First idea \nBetter:");
    expect(stripKnowledgeBaseDraft('Streaming <kb_draft>{"name":"Q')).toBe("Streaming");
    expect(parseKnowledgeBaseDraft("<kb_draft>{not json}</kb_draft>")).toBeNull();
    expect(parseKnowledgeBaseDraft('<kb_draft>{"name":" "}</kb_draft>')).toBeNull();
  });

  it("defaults missing checks and maps unknown lint codes to other", () => {
    const base = { id: "c1", number: 1, title: "t", branch: "kb/x" };
    expect(KnowledgeChangeDetailSchema.parse(base).checks).toEqual({ lint: [], stale: [] });

    const parsed = KnowledgeChangeDetailSchema.parse({
      ...base,
      checks: { lint: [{ code: "future_rule", severity: "fatal", path: "a.md" }], stale: null },
    });
    expect(parsed.checks.lint[0]).toMatchObject({ code: "other", severity: "warning", path: "a.md" });
    expect(parsed.checks.stale).toEqual([]);
  });

  it("defaults a malformed delete impact", () => {
    expect(parseWithFallback("nope", KnowledgeDeleteImpactSchema, EMPTY_KNOWLEDGE_DELETE_IMPACT, opts)).toEqual(
      EMPTY_KNOWLEDGE_DELETE_IMPACT,
    );
  });
});
