import { parseDraftBlock, stripDraftBlock } from "../agents/builder-protocol";
import type {
  KbBuilderMode,
  KnowledgeBaseDetail,
  KnowledgeBaseSchemaMode,
  StoredKbDraft,
} from "../types/kb";

/**
 * Wire format between the knowledge base configuration page and its hidden
 * builder agent, the counterpart of the agent builder's protocol:
 *   - Outbound, composer text is wrapped in a JSON envelope carrying the
 *     current schema mode (the builder follows the latest one) and the
 *     configuration on the right.
 *   - Inbound, the builder ends every reply with one `<kb_draft>{…}</kb_draft>`
 *     line; it fills the form and is stripped before the reply is shown.
 */
const KB_BUILDER_INPUT_PREFIX = "MARVIS_KB_BUILDER_INPUT\n";
const KB_DRAFT_TAG = "kb_draft";

/** Slug rule shared with the server: lowercase letters, digits, single hyphens. */
export const KB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Slugs that are route segments under /{workspace}/kb. */
const RESERVED_KB_SLUGS = new Set(["new"]);

/** The editable right-hand configuration. */
export interface KbDraft {
  name: string;
  slug: string;
  description: string;
  purpose: string;
  schemaMode: KnowledgeBaseSchemaMode;
  /** The schema text; only sent in the custom mode. */
  schema: string;
}

export const EMPTY_KB_DRAFT: KbDraft = {
  name: "",
  slug: "",
  description: "",
  purpose: "",
  schemaMode: "default",
  schema: "",
};

/** What a builder reply may carry; every field is untrusted. */
export interface KbDraftPayload {
  name?: unknown;
  slug?: unknown;
  description?: unknown;
  purpose?: unknown;
  schema?: unknown;
}

export function isValidKbSlug(slug: string): boolean {
  return KB_SLUG_PATTERN.test(slug) && !RESERVED_KB_SLUGS.has(slug);
}

export function parseKbDraft(
  content: string,
  options: { completed?: boolean } = {},
): KbDraftPayload | null {
  return parseDraftBlock(content, KB_DRAFT_TAG, options);
}

export function stripKbDraft(content: string): string {
  return stripDraftBlock(content, KB_DRAFT_TAG);
}

export function encodeKbBuilderInput(request: string, draft: KbDraft): string {
  return (
    KB_BUILDER_INPUT_PREFIX +
    JSON.stringify(
      {
        user_request: request,
        schema_mode: draft.schemaMode,
        current_draft: {
          name: draft.name,
          slug: draft.slug,
          description: draft.description,
          purpose: draft.purpose,
          ...(draft.schemaMode === "custom" ? { schema: draft.schema } : {}),
        },
      },
      null,
      2,
    )
  );
}

export function decodeKbBuilderInput(content: string): string {
  if (!content.startsWith(KB_BUILDER_INPUT_PREFIX)) return content;
  try {
    const parsed = JSON.parse(content.slice(KB_BUILDER_INPUT_PREFIX.length)) as {
      user_request?: unknown;
    };
    return typeof parsed.user_request === "string" ? parsed.user_request : content;
  } catch {
    return content;
  }
}

/**
 * Applies a builder reply to the form. The schema mode is the member's
 * choice, never the builder's, so a schema is taken only in the custom mode;
 * configuring keeps the slug, which cannot change.
 */
export function mergeKbDraft(current: KbDraft, payload: KbDraftPayload, mode: KbBuilderMode): KbDraft {
  const pick = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

  return {
    ...current,
    name: pick(payload.name, current.name),
    slug: mode === "create" ? pick(payload.slug, current.slug).trim().toLowerCase() : current.slug,
    description: pick(payload.description, current.description),
    purpose: pick(payload.purpose, current.purpose),
    schema: current.schemaMode === "custom" ? pick(payload.schema, current.schema) : current.schema,
  };
}

export function toStoredKbDraft(draft: KbDraft, appliedMessageId: string | null): StoredKbDraft {
  return {
    name: draft.name,
    slug: draft.slug,
    description: draft.description,
    purpose: draft.purpose,
    schema_mode: draft.schemaMode,
    schema: draft.schemaMode === "custom" ? draft.schema : "",
    applied_message_id: appliedMessageId,
  };
}

/**
 * Rebuilds the form from a saved configuration. A saved default-mode draft
 * carries no schema text, so the read-only schema comes from `defaultSchema`.
 */
export function fromStoredKbDraft(stored: StoredKbDraft, defaultSchema: string): KbDraft {
  return {
    name: stored.name,
    slug: stored.slug,
    description: stored.description,
    purpose: stored.purpose,
    schemaMode: stored.schema_mode,
    schema: stored.schema_mode === "custom" ? stored.schema : defaultSchema,
  };
}

export function storedKbDraftsEqual(a: StoredKbDraft, b: StoredKbDraft): boolean {
  return (
    a.name === b.name &&
    a.slug === b.slug &&
    a.description === b.description &&
    a.purpose === b.purpose &&
    a.schema_mode === b.schema_mode &&
    a.schema === b.schema &&
    a.applied_message_id === b.applied_message_id
  );
}

/** The configuration a knowledge base has now, as the form edits it. */
export function kbDraftFromBase(base: KnowledgeBaseDetail): KbDraft {
  return {
    name: base.name,
    slug: base.slug,
    description: base.description,
    purpose: base.purpose,
    schemaMode: base.schema_mode === "custom" ? "custom" : "default",
    schema: base.schema,
  };
}

/** Whether the form differs from the saved configuration. */
export function isKbDraftChanged(draft: KbDraft, base: KbDraft): boolean {
  return (
    draft.name !== base.name ||
    draft.description !== base.description ||
    draft.purpose !== base.purpose ||
    draft.schemaMode !== base.schemaMode ||
    (draft.schemaMode === "custom" && draft.schema !== base.schema)
  );
}

/** A configuration save; null when the form cannot be saved. */
export function kbUpdateRequest(draft: KbDraft, baseUpdatedAt: string) {
  const name = draft.name.trim();
  if (!name) return null;
  if (draft.schemaMode === "custom" && !draft.schema.trim()) return null;

  return {
    name,
    description: draft.description.trim(),
    purpose: draft.purpose,
    schema_mode: draft.schemaMode,
    ...(draft.schemaMode === "custom" ? { schema: draft.schema } : {}),
    ...(baseUpdatedAt ? { base_updated_at: baseUpdatedAt } : {}),
  };
}

/** The configuration the create form is ready to submit; null when it is not. */
export function kbCreateRequest(draft: KbDraft) {
  const name = draft.name.trim();
  const slug = draft.slug.trim().toLowerCase();
  if (!name || !isValidKbSlug(slug)) return null;
  if (draft.schemaMode === "custom" && !draft.schema.trim()) return null;

  return {
    name,
    slug,
    description: draft.description.trim(),
    purpose: draft.purpose,
    schema_mode: draft.schemaMode,
    ...(draft.schemaMode === "custom" ? { schema: draft.schema } : {}),
  };
}
