import { stripMentionMarkdown } from "../../issues/utils/strip-mention-markdown";

/**
 * Plain-text preview of an autopilot's markdown instructions for the list
 * card. Drops markdown syntax and collapses all whitespace into single
 * spaces; the card clamps the result to two lines with CSS.
 */
export function instructionsPreview(markdown: string | null | undefined): string {
  if (!markdown) return "";

  const text = stripMentionMarkdown(markdown)
    // Fence lines carry only the language tag; the code body is kept.
    .replace(/^\s*(```|~~~).*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    // Single-char emphasis only at word boundaries, so snake_case survives.
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2");

  return text.replace(/\s+/g, " ").trim();
}
