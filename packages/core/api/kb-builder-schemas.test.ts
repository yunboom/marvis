// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseWithFallback } from "./schema";
import {
  EMPTY_KB_BUILDER_SESSION_LIST,
  EMPTY_KB_BUILDER_SESSION_START,
  EMPTY_KB_TEMPLATES,
  KbBuilderRuntimeSwitchSchema,
  KbBuilderSessionListSchema,
  KbBuilderSessionStartSchema,
  KbTemplatesSchema,
  KnowledgeBaseMutationSchema,
  kbBuilderRuntimeSwitchFallback,
  knowledgeBaseMutationFallback,
} from "./kb-schemas";
import type { KbBuilderSession, KnowledgeBaseMutation } from "../types/kb";

const opts = { endpoint: "test" };

describe("knowledge base builder session list", () => {
  const parse = (raw: unknown): KbBuilderSession[] =>
    parseWithFallback(raw, KbBuilderSessionListSchema, EMPTY_KB_BUILDER_SESSION_LIST, opts);

  it("parses sessions with a stored draft", () => {
    const [session] = parse([
      {
        session_id: "s1",
        mode: "create",
        knowledge_base_id: null,
        title: "Create a knowledge base",
        runtime_id: "rt1",
        last_message_content: "<kb_draft>{}</kb_draft>",
        last_message_role: "assistant",
        last_message_at: "2026-10-25T09:16:00Z",
        draft: { name: "支付排障手册", slug: "pay", schema_mode: "custom", schema: "# S", applied_message_id: "m1" },
        updated_at: "2026-10-25T09:16:00Z",
      },
    ]);
    expect(session?.draft).toMatchObject({ name: "支付排障手册", schema_mode: "custom", applied_message_id: "m1" });
    expect(session?.knowledge_base_id).toBeNull();
  });

  it("drops rows without an id and defaults broken fields", () => {
    const parsed = parse([
      { title: "no id" },
      { session_id: "s2", draft: "garbage", last_message_at: 5, knowledge_base_id: 1 },
      { session_id: "s3", draft: { schema_mode: "weird", applied_message_id: 3 } },
    ]);
    expect(parsed.map((s) => s.session_id)).toEqual(["s2", "s3"]);
    expect(parsed[0]).toMatchObject({ draft: null, last_message_at: null, knowledge_base_id: null, mode: "create" });
    expect(parsed[1]?.draft).toMatchObject({ name: "", schema_mode: "default", applied_message_id: null });
  });

  it("falls back to an empty list for a non-array", () => {
    expect(parse({ sessions: [] })).toEqual([]);
  });
});

describe("knowledge base builder start and switch", () => {
  it("falls back when the session id is missing", () => {
    expect(parseWithFallback({ runtime_id: "rt" }, KbBuilderSessionStartSchema, EMPTY_KB_BUILDER_SESSION_START, opts)).toEqual(
      EMPTY_KB_BUILDER_SESSION_START,
    );
  });

  it("assumes the requested runtime when a switch body does not parse", () => {
    const fallback = kbBuilderRuntimeSwitchFallback("rt-9");
    expect(parseWithFallback("oops", KbBuilderRuntimeSwitchSchema, fallback, opts).runtime_id).toBe("rt-9");
    expect(parseWithFallback({ runtime_id: "rt-2" }, KbBuilderRuntimeSwitchSchema, fallback, opts).runtime_id).toBe("rt-2");
  });
});

describe("knowledge base writes", () => {
  const parse = (raw: unknown, slug: string): KnowledgeBaseMutation =>
    parseWithFallback(raw, KnowledgeBaseMutationSchema, knowledgeBaseMutationFallback(slug), opts);

  it("parses the created base with its mention", () => {
    const parsed = parse({ id: "kb1", name: "n", slug: "pay", mention: "[n](mention://kb/kb1)" }, "pay");
    expect(parsed).toMatchObject({ id: "kb1", slug: "pay", mention: "[n](mention://kb/kb1)", page_count: 0 });
  });

  it("keeps the requested slug when the body is malformed", () => {
    expect(parse({ name: "no id" }, "pay")).toMatchObject({ id: "", slug: "pay", mention: "" });
  });

  it("parses templates and defaults missing text", () => {
    expect(parseWithFallback({ default_schema: "# Schema" }, KbTemplatesSchema, EMPTY_KB_TEMPLATES, opts)).toEqual({
      default_schema: "# Schema",
      purpose_template: "",
    });
  });
});
