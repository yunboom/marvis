// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  EMPTY_KB_DRAFT,
  decodeKbBuilderInput,
  encodeKbBuilderInput,
  fromStoredKbDraft,
  isKbDraftChanged,
  isValidKbSlug,
  kbBuilderSessionHasUnsavedChanges,
  kbCreateRequest,
  kbUpdateRequest,
  mergeKbDraft,
  parseKbDraft,
  stripKbDraft,
  toStoredKbDraft,
  type KbDraft,
} from "./builder-protocol";

const REPLY = `好的，按你说的起草了。
<kb_draft>{"name":"支付排障手册","slug":"Pay-Troubleshoot","description":"支付排障。","purpose":"# 目标\\n\\n## 读者\\n研发","schema":"# Schema\\nX"}</kb_draft>`;

describe("kb_draft blocks", () => {
  it("parses and strips a closed block", () => {
    expect(parseKbDraft(REPLY)?.name).toBe("支付排障手册");
    expect(stripKbDraft(REPLY)).toBe("好的，按你说的起草了。");
  });

  it("hides a block still streaming and recovers a completed unclosed one", () => {
    const streaming = '起草中\n<kb_draft>{"name":"支';
    expect(stripKbDraft(streaming)).toBe("起草中");
    expect(parseKbDraft(streaming)).toBeNull();
    expect(parseKbDraft('x <kb_draft>{"name":"a\nb"}', { completed: true })?.name).toBe("a\nb");
  });

  it("ignores agent builder blocks", () => {
    expect(parseKbDraft('<agent_draft>{"name":"x"}</agent_draft>')).toBeNull();
  });
});

describe("mergeKbDraft", () => {
  const payload = parseKbDraft(REPLY)!;

  it("fills the form and normalises the slug when creating", () => {
    const merged = mergeKbDraft(EMPTY_KB_DRAFT, payload, "create");
    expect(merged).toMatchObject({ name: "支付排障手册", slug: "pay-troubleshoot", purpose: "# 目标\n\n## 读者\n研发" });
  });

  it("takes a schema only in the custom mode", () => {
    expect(mergeKbDraft({ ...EMPTY_KB_DRAFT, schema: "# Default" }, payload, "create").schema).toBe("# Default");
    expect(mergeKbDraft({ ...EMPTY_KB_DRAFT, schemaMode: "custom" }, payload, "create").schema).toBe("# Schema\nX");
  });

  it("keeps the slug when configuring", () => {
    expect(mergeKbDraft({ ...EMPTY_KB_DRAFT, slug: "team" }, payload, "config").slug).toBe("team");
  });

  it("keeps fields the reply does not carry as strings", () => {
    const current: KbDraft = { ...EMPTY_KB_DRAFT, name: "Keep", description: "d" };
    expect(mergeKbDraft(current, { name: 3, description: null }, "create")).toEqual(current);
  });
});

describe("builder envelope", () => {
  it("carries the request, the schema mode and the draft", () => {
    const encoded = encodeKbBuilderInput("给研发看", { ...EMPTY_KB_DRAFT, name: "n", schema: "# S" });
    const body = JSON.parse(encoded.slice(encoded.indexOf("\n") + 1));
    expect(body).toMatchObject({ user_request: "给研发看", schema_mode: "default", current_draft: { name: "n" } });
    expect(body.current_draft.schema).toBeUndefined();
    expect(decodeKbBuilderInput(encoded)).toBe("给研发看");

    const custom = encodeKbBuilderInput("x", { ...EMPTY_KB_DRAFT, schemaMode: "custom", schema: "# S" });
    expect(JSON.parse(custom.slice(custom.indexOf("\n") + 1)).current_draft.schema).toBe("# S");
  });

  it("leaves plain text alone", () => {
    expect(decodeKbBuilderInput("hello")).toBe("hello");
  });
});

describe("stored drafts and requests", () => {
  it("round-trips, dropping a default-mode schema", () => {
    const draft: KbDraft = { name: "n", slug: "s", description: "d", purpose: "p", schemaMode: "default", schema: "# Built-in" };
    const stored = toStoredKbDraft(draft, "m1");
    expect(stored.schema).toBe("");
    expect(fromStoredKbDraft(stored, "# Built-in")).toEqual(draft);
  });

  it("validates slugs like the server", () => {
    expect(isValidKbSlug("pay-1")).toBe(true);
    expect(isValidKbSlug("Pay")).toBe(false);
    expect(isValidKbSlug("a--b")).toBe(false);
    expect(isValidKbSlug("new")).toBe(false);
  });

  it("builds create and update requests", () => {
    const draft: KbDraft = { name: " n ", slug: "s", description: " d ", purpose: "p", schemaMode: "default", schema: "# B" };
    expect(kbCreateRequest(draft)).toEqual({ name: "n", slug: "s", description: "d", purpose: "p", schema_mode: "default" });
    expect(kbCreateRequest({ ...draft, slug: "bad slug" })).toBeNull();
    expect(kbCreateRequest({ ...draft, schemaMode: "custom", schema: " " })).toBeNull();
    expect(kbUpdateRequest({ ...draft, schemaMode: "custom" }, "2026-10-25T00:00:00Z")).toMatchObject({
      schema: "# B",
      base_updated_at: "2026-10-25T00:00:00Z",
    });
  });

  it("detects changes against the saved configuration", () => {
    const base: KbDraft = { name: "n", slug: "s", description: "", purpose: "", schemaMode: "default", schema: "# B" };
    expect(isKbDraftChanged({ ...base }, base)).toBe(false);
    expect(isKbDraftChanged({ ...base, purpose: "x" }, base)).toBe(true);
    expect(isKbDraftChanged({ ...base, schemaMode: "custom" }, base)).toBe(true);
  });

  it("lists a configuration conversation only while it holds unsaved changes", () => {
    const base = {
      id: "kb-1", workspace_id: "ws", name: "Team", slug: "team", description: "", schema_mode: "default", created_by: "u",
      page_count: 0, content_version: 0, created_at: "", updated_at: "", pending: { annotations: 0, stale_pages: 0, open_mrs: 0 },
      purpose: "Answers.", schema: "# B",
    };
    const session = {
      session_id: "s", mode: "config", knowledge_base_id: "kb-1", title: "", runtime_id: "rt", last_message_content: "",
      last_message_role: "user", last_message_at: null, draft: null, updated_at: "",
    };
    const saved = { name: "Team", slug: "team", description: "", purpose: "Answers.", schema_mode: "default" as const, schema: "", applied_message_id: null };

    expect(kbBuilderSessionHasUnsavedChanges(session, base)).toBe(false);
    expect(kbBuilderSessionHasUnsavedChanges({ ...session, draft: saved }, base)).toBe(false);
    expect(kbBuilderSessionHasUnsavedChanges({ ...session, draft: { ...saved, purpose: "More." } }, base)).toBe(true);
    const proposal = 'Done.\n<kb_draft>{"name":"Team","slug":"team","description":"Payments","purpose":"Answers."}</kb_draft>';
    expect(kbBuilderSessionHasUnsavedChanges({ ...session, last_message_role: "assistant", last_message_content: proposal }, base)).toBe(true);
  });
});
