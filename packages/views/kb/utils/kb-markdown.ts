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

/** Class of the mark under an annotated sentence. */
export const KB_ANNOTATED_CLASS = "kb-annotated";

/** Attribute listing the annotations on a marked sentence, comma separated. */
export const KB_ANNOTATION_IDS_ATTR = "data-annotation-ids";

const ANNOTATION_ID = /^[\w-]+$/;

/** An annotated sentence of a block and the annotations on it. */
export interface KbQuoteMark {
  quote: string;
  ids: readonly string[];
  /** Page text right before the sentence; picks the occurrence when it repeats. */
  prefix?: string;
  /** Page text right after the sentence. */
  suffix?: string;
}

export interface PrepareBlockOptions {
  /** Citation number of each source id, 1-based, in page order. */
  citeNumbers: ReadonlyMap<string, number>;
  /** Claim sentences to highlight as possibly outdated. */
  highlights?: readonly string[];
  /** Annotated sentences to underline. */
  annotations?: readonly KbQuoteMark[];
}

/** The annotation ids a marked sentence carries. */
export function annotationIdsOf(element: Element): string[] {
  return (element.getAttribute(KB_ANNOTATION_IDS_ATTR) ?? "").split(",").filter(Boolean);
}

/** Rewrites a block's Markdown for rendering on the reading page. */
export function prepareBlockMarkdown(content: string, options: PrepareBlockOptions): string {
  let out = content.replace(FOOTNOTE_REF, (match, id: string) => {
    const n = options.citeNumbers.get(id);
    return n ? `[${n}](${KB_CITE_HREF_PREFIX}${encodeURIComponent(id)})` : match;
  });

  out = out.replace(UNWRITTEN_PAGE_LINK, `](${KB_MISSING_PAGE_HREF})`);

  out = markAnnotatedSentences(out, options.annotations ?? []);

  for (const sentence of options.highlights ?? []) {
    const text = sentence.trim();
    if (!text || !out.includes(text) || out.includes(`<mark>${text}`)) continue;
    out = out.replace(text, `<mark>${text}</mark>`);
  }

  return out;
}

// Annotated sentences

/**
 * How a character of a block's Markdown reads on the page: shown as written
 * (`text`), markup that shows nothing such as link brackets and destinations,
 * tags and list markers (`markup`), emphasis and escapes that show nothing
 * but must stay inside a mark that touches them (`inline`), or markup that
 * reads as a space (`gap`): a citation, which the server drops as one when
 * anchoring.
 */
type CharRole = "text" | "markup" | "inline" | "gap";

// Markup of prepared Markdown, in the order roles are claimed: a character
// keeps the first role given to it.
const CITE_LINK = /\[\d+\]\(#kb-cite-[^)\s]*\)/g;
const DELETED_TEXT = /<del>[\s\S]*?<\/del>/g;
const HTML_TAG = /<\/?[A-Za-z][^>\n]*>/g;
const INLINE_LINK = /!?\[([^\]\n]*)\]\([^)\n]*\)/g;
// Indentation before a marker is whitespace, which a quote may span.
const LINE_MARKERS = /(?<=^[ \t]*)(?:(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+)+(?:\[[ xX]\][ \t]+)?/gm;
const ESCAPE = /\\(?=[!-/:-@[-`{-~])/g;
const EMPHASIS_MARKERS = /\*+|~~|`+|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu;

/**
 * The text a block's Markdown shows, whitespace collapsed like the server's
 * anchor text, with where each character came from in the source.
 */
interface ReadableText {
  text: string;
  /** Source offset of each character of `text`. */
  from: number[];
  /** Role of each source character. */
  roles: CharRole[];
}

function readableText(markdown: string): ReadableText {
  const roles = new Array<CharRole>(markdown.length).fill("text");
  const claim = (start: number, end: number, role: CharRole) => {
    for (let i = start; i < end; i++) {
      if (roles[i] === "text") roles[i] = role;
    }
  };
  const claimAll = (pattern: RegExp, role: CharRole) => {
    for (const match of markdown.matchAll(pattern)) claim(match.index, match.index + match[0].length, role);
  };

  claimAll(CITE_LINK, "gap");
  claimAll(FOOTNOTE_REF, "gap");
  claimAll(DELETED_TEXT, "markup");
  claimAll(HTML_TAG, "markup");
  for (const match of markdown.matchAll(INLINE_LINK)) {
    // The label reads as text; the brackets and the destination do not.
    const labelStart = match.index + match[0].indexOf("[") + 1;
    const labelEnd = labelStart + (match[1] ?? "").length;
    claim(match.index, labelStart, "markup");
    claim(labelEnd, match.index + match[0].length, "markup");
  }
  claimAll(LINE_MARKERS, "markup");
  claimAll(ESCAPE, "inline");
  claimAll(EMPHASIS_MARKERS, "inline");

  let text = "";
  const from: number[] = [];
  for (let i = 0; i < markdown.length; i++) {
    if (roles[i] === "markup" || roles[i] === "inline") continue;

    const char = markdown[i]!;
    if (roles[i] === "gap" || /\s/.test(char)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        from.push(i);
      }
      continue;
    }

    text += char;
    from.push(i);
  }

  return { text, from, roles };
}

/** Collapses whitespace runs into one space, as the server stores quotes and context. */
function collapseSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** How many characters of the remembered context sit right next to text[start:end]. */
function contextScore(text: string, start: number, end: number, prefix: string, suffix: string): number {
  let score = 0;
  for (let i = 1; i <= prefix.length && start - i >= 0 && text[start - i] === prefix[prefix.length - i]; i++) score++;
  for (let i = 0; i < suffix.length && end + i < text.length && text[end + i] === suffix[i]; i++) score++;

  return score;
}

/**
 * The pieces of markdown[start:end] that can each carry a mark: runs of shown
 * text split at markup a mark cannot cross (list and heading markers, link
 * brackets and destinations, tags, citations) and at paragraph breaks, so a
 * sentence over several list items gets one mark per item. Emphasis and
 * escapes next to a piece are pulled inside it, since a mark between a
 * delimiter and its text stops the delimiter from closing; a piece whose
 * emphasis does not pair up is dropped rather than broken.
 */
function markPieces(markdown: string, roles: readonly CharRole[], start: number, end: number): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let i = start; i <= end; i++) {
    const inRun = i < end && (roles[i] === "text" || roles[i] === "inline");
    if (inRun && runStart < 0) runStart = i;
    if (!inRun && runStart >= 0) {
      let from = runStart;
      for (const paragraph of markdown.slice(runStart, i).split(PARAGRAPH_BREAK)) {
        runs.push({ start: from, end: from + paragraph.length });
        from += paragraph.length;
      }
      runStart = -1;
    }
  }

  const pieces: { start: number; end: number }[] = [];
  for (const run of runs) {
    let s = run.start;
    let e = run.end;
    while (s < e && /\s/.test(markdown[s]!)) s++;
    while (e > s && /\s/.test(markdown[e - 1]!)) e--;
    if (!roles.slice(s, e).includes("text")) continue;

    while (s > 0 && roles[s - 1] === "inline") s--;
    while (e < markdown.length && roles[e] === "inline") e++;
    if (!emphasisPairsUp(markdown.slice(s, e))) continue;

    pieces.push({ start: s, end: e });
  }

  return pieces;
}

const PARAGRAPH_BREAK = /(?<=\n[ \t]*\n)/;

/** Whether every emphasis delimiter in a piece of Markdown has its partner. */
function emphasisPairsUp(markdown: string): boolean {
  const counts = new Map<string, number>();
  for (const [marker] of markdown.replace(ESCAPED_CHAR, "").matchAll(EMPHASIS_MARKERS)) {
    counts.set(marker, (counts.get(marker) ?? 0) + 1);
  }

  return [...counts.values()].every((count) => count % 2 === 0);
}

const ESCAPED_CHAR = /\\[!-/:-@[-`{-~]/g;

/**
 * Wraps each annotated sentence in marks. The sentence is looked up in the
 * text the block shows, as the server anchored it, never in link
 * destinations, citations or deleted text; when it repeats, the occurrence
 * whose surroundings match the remembered context wins. A sentence that
 * crosses markup gets one mark per piece between that markup (see
 * markPieces), all carrying the same annotation ids.
 */
function markAnnotatedSentences(markdown: string, marks: readonly KbQuoteMark[]): string {
  if (marks.length === 0) return markdown;

  const readable = readableText(markdown);
  const placed: { start: number; end: number; ids: string[]; pieces: { start: number; end: number }[] }[] = [];
  for (const mark of marks) {
    const quote = collapseSpaces(mark.quote);
    const ids = mark.ids.filter((id) => ANNOTATION_ID.test(id));
    if (!quote || ids.length === 0) continue;

    const prefix = (mark.prefix ?? "").replace(/\s+/g, " ");
    const suffix = (mark.suffix ?? "").replace(/\s+/g, " ");
    let best: { start: number; end: number; score: number; pieces: { start: number; end: number }[] } | null = null;
    for (let at = readable.text.indexOf(quote); at >= 0; at = readable.text.indexOf(quote, at + 1)) {
      const start = readable.from[at]!;
      const end = readable.from[at + quote.length - 1]! + 1;
      const pieces = markPieces(markdown, readable.roles, start, end);
      if (pieces.length === 0) continue;

      const score = contextScore(readable.text, at, at + quote.length, prefix, suffix);
      if (!best || score > best.score) best = { start: pieces[0]!.start, end: pieces[pieces.length - 1]!.end, score, pieces };
    }
    if (!best) continue;

    // Annotations on the same sentence share its marks; marks cannot nest.
    const { start, end, pieces } = best;
    const same = placed.find((other) => other.start === start && other.end === end);
    if (same) same.ids.push(...ids);
    else if (!placed.some((other) => start < other.end && other.start < end)) placed.push({ start, end, ids: [...ids], pieces });
  }

  const wraps = placed.flatMap(({ ids, pieces }) => pieces.map((piece) => ({ ...piece, ids })));
  let out = markdown;
  for (const { start, end, ids } of wraps.sort((a, b) => b.start - a.start)) {
    const open = `<mark class="${KB_ANNOTATED_CLASS}" ${KB_ANNOTATION_IDS_ATTR}="${ids.join(",")}">`;
    out = out.slice(0, start) + open + out.slice(start, end) + "</mark>" + out.slice(end);
  }

  return out;
}

/** The mark of an annotation on the reading page, or null when its sentence is not shown. */
export function findAnnotationMark(root: ParentNode | null | undefined, annotationId: string): HTMLElement | null {
  if (!root) return null;

  const marks = root.querySelectorAll<HTMLElement>(`mark.${KB_ANNOTATED_CLASS}`);
  return Array.from(marks).find((mark) => annotationIdsOf(mark).includes(annotationId)) ?? null;
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

/**
 * The section a block sits in: its own heading when it is one, otherwise the
 * nearest heading above it. Empty when the block is missing or no heading
 * precedes it.
 */
export function blockSection(blocks: readonly KbBlock[], blockId: string): string {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return "";

  const headings = new Map(pageHeadings(blocks.slice(0, index + 1)).map((h) => [h.blockId, h.text]));
  for (let i = index; i >= 0; i--) {
    const text = headings.get(blocks[i]!.id);
    if (text) return text;
  }

  return "";
}

/** A block as one line of plain text: no heading or list markers, links reduced to their text, footnote marks dropped. */
export function blockPlainText(content: string): string {
  return content
    .replace(FOOTNOTE_REF, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(INLINE_MARKUP, (_, label?: string) => label ?? "")
    .replace(/\s+/g, " ")
    .trim();
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

/** A body link to a page of one knowledge base: the page and its #block fragment. */
export interface KbPageLink {
  pageId: string;
  hash: string;
}

/**
 * The page a body link opens when it is an in-app link to a page of the
 * knowledge base `kbSlug`: `/kb/{slug}/p/{page}` as the server writes it, or
 * the same route under a workspace slug. Anything else is null.
 */
export function kbPageLink(href: string | null, kbSlug: string): KbPageLink | null {
  if (!href?.startsWith("/") || href.startsWith("//") || !kbSlug) return null;

  const hashAt = href.indexOf("#");
  const hash = hashAt < 0 ? "" : href.slice(hashAt);
  const path = (hashAt < 0 ? href : href.slice(0, hashAt)).split("?")[0] ?? "";
  const parts = path.split("/").filter(Boolean).map(safeDecode);
  const route = parts[0] === "kb" ? parts : parts.slice(1);
  if (route.length !== 4 || route[0] !== "kb" || route[1] !== kbSlug || route[2] !== "p" || !route[3]) return null;

  return { pageId: route[3], hash };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
