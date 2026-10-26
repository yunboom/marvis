import type { KbBlock } from "@marvis/core/types";

/**
 * Markdown preparation for the knowledge base reading page.
 *
 * Page blocks arrive as Markdown with page links already turned into app
 * routes (`/kb/<slug>/p/<id>#<block>`). What is left to the client:
 * footnotes `[^id]` become numbered citation links the page intercepts,
 * links to pages not written yet become inert, stale claims get highlighted,
 * and a draft's edits are shown inline against the published text.
 */

/** Href prefix of a citation link; the source id follows, URI-encoded. */
export const KB_CITE_HREF_PREFIX = "#kb-cite-";

/** Href of a link to a page that has not been written yet. */
export const KB_MISSING_PAGE_HREF = "#kb-missing";

const FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;
const FOOTNOTE_DEFINITION_LINE = /^\[\^[^\]\s]+\]:/;
const UNWRITTEN_PAGE_LINK = /\]\((\/[^)\s]*?\.md(?:#[^)\s]*)?)\)/g;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const INLINE_MARKUP = /[*_`~]|\[([^\]]*)\]\([^)]*\)/g;

/** Whether a block holds nothing but footnote definitions. */
export function isFootnoteDefinitionBlock(content: string): boolean {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  return lines.length > 0 && lines.every((line) => FOOTNOTE_DEFINITION_LINE.test(line.trim()));
}

/** The source id a citation href points at, or null for any other href. */
export function citeSourceId(href: string | null | undefined): string | null {
  if (!href?.startsWith(KB_CITE_HREF_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(KB_CITE_HREF_PREFIX.length));
  } catch {
    return null;
  }
}

export interface PrepareBlockOptions {
  /** Citation number of each source id, 1-based, in page order. */
  citeNumbers: ReadonlyMap<string, number>;
  /** Claim sentences to highlight as possibly outdated. */
  highlights?: readonly string[];
}

/** Rewrites a block's Markdown for rendering on the reading page. */
export function prepareBlockMarkdown(content: string, options: PrepareBlockOptions): string {
  let out = content.replace(FOOTNOTE_REF, (match, id: string) => {
    const n = options.citeNumbers.get(id);
    return n ? `[${n}](${KB_CITE_HREF_PREFIX}${encodeURIComponent(id)})` : match;
  });

  out = out.replace(UNWRITTEN_PAGE_LINK, `](${KB_MISSING_PAGE_HREF})`);

  for (const sentence of options.highlights ?? []) {
    const text = sentence.trim();
    if (!text || !out.includes(text) || out.includes(`<mark>${text}`)) continue;
    out = out.replace(text, `<mark>${text}</mark>`);
  }

  return out;
}

/** Numbers sources in page order for citation links. */
export function citeNumbers(sourceIds: readonly string[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const id of sourceIds) {
    if (!numbers.has(id)) numbers.set(id, numbers.size + 1);
  }
  return numbers;
}

export interface KbHeading {
  blockId: string;
  level: number;
  text: string;
}

/** The headings of a page in order, for its table of contents. */
export function pageHeadings(blocks: readonly KbBlock[]): KbHeading[] {
  const headings: KbHeading[] = [];
  for (const block of blocks) {
    const firstLine = block.content.split("\n", 1)[0] ?? "";
    const match = HEADING.exec(firstLine);
    if (!match?.[1] || !match[2]) continue;
    headings.push({
      blockId: block.id,
      level: match[1].length,
      text: match[2].replace(INLINE_MARKUP, (_, label?: string) => label ?? "").trim(),
    });
  }
  return headings;
}

// Draft comparison

export type KbBlockChange =
  | { kind: "same"; block: KbBlock }
  | { kind: "changed"; block: KbBlock; previous: KbBlock }
  | { kind: "added"; block: KbBlock }
  | { kind: "removed"; block: KbBlock };

/**
 * Lines up a draft's blocks with the published ones by block id. Removed
 * blocks are placed where they stood in the published page.
 */
export function compareBlocks(published: readonly KbBlock[], draft: readonly KbBlock[]): KbBlockChange[] {
  const publishedIndex = new Map(published.map((block, i) => [block.id, i]));
  const draftIds = new Set(draft.map((block) => block.id));
  const changes: KbBlockChange[] = [];

  let next = 0;
  const flushRemoved = (until: number) => {
    for (; next < until; next++) {
      const block = published[next]!;
      if (!draftIds.has(block.id)) changes.push({ kind: "removed", block });
    }
  };

  for (const block of draft) {
    const index = publishedIndex.get(block.id);
    if (index === undefined) {
      changes.push({ kind: "added", block });
      continue;
    }
    flushRemoved(index);
    next = Math.max(next, index + 1);

    const previous = published[index]!;
    changes.push(
      previous.content === block.content ? { kind: "same", block } : { kind: "changed", block, previous },
    );
  }
  flushRemoved(published.length);

  return changes;
}

const DIFF_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|\s+|[^\s]/gu;
const MARKDOWN_SYNTAX = /[[\]()*_`#<>|!~\\\n]/;
const MAX_DIFF_CELLS = 250_000;

type Segment = { op: "equal" | "deleted" | "added"; text: string };

function tokenize(text: string): string[] {
  return text.match(DIFF_TOKEN) ?? [];
}

function diffTokens(before: string[], after: string[]): Segment[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j]: common subsequence length of before[i:] and after[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const segments: Segment[] = [];
  const push = (op: Segment["op"], text: string) => {
    const last = segments[segments.length - 1];
    if (last?.op === op) last.text += text;
    else segments.push({ op, text });
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      push("equal", before[i]!);
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      push("added", after[j]!);
      j++;
    } else {
      push("deleted", before[i]!);
      i++;
    }
  }

  return segments;
}

/**
 * Renders a draft's edit of a block inline: removed words as `<del>`, added
 * words as `<ins>`. Returns null when the edit touches Markdown syntax or is
 * too large, so the caller shows the whole old and new block instead.
 */
export function inlineDiffMarkdown(before: string, after: string): string | null {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return null;

  const segments = diffTokens(a, b);
  let out = "";
  for (const segment of segments) {
    if (segment.op !== "equal" && MARKDOWN_SYNTAX.test(segment.text)) return null;
    if (segment.op === "equal") out += segment.text;
    else if (segment.op === "deleted") out += `<del>${segment.text}</del>`;
    else out += `<ins>${segment.text}</ins>`;
  }

  return out;
}

/** Route segments of a knowledge base page: /{ws}/kb/{slug}[/p/{page}[/history/{revision}]]. */
export interface KbRouteParams {
  kbSlug: string;
  pageId: string;
  revisionId: string;
}

/** Reads the knowledge base route parameters from a pathname. */
export function parseKbRoute(pathname: string): KbRouteParams {
  const parts = pathname.split("/").filter(Boolean).map(safeDecode);
  // parts[0] is the workspace slug.
  const kbIndex = 1;
  const params: KbRouteParams = { kbSlug: "", pageId: "", revisionId: "" };
  if (parts[kbIndex] !== "kb") return params;

  params.kbSlug = parts[kbIndex + 1] ?? "";
  if (parts[kbIndex + 2] === "p") params.pageId = parts[kbIndex + 3] ?? "";
  if (parts[kbIndex + 4] === "history") params.revisionId = parts[kbIndex + 5] ?? "";
  return params;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
