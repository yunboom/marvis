/**
 * The box every mention chip shares (issue, project, knowledge base): a
 * bordered pill that sits inside a line of prose or a chat bubble and
 * truncates at `min(18rem, 100%)`.
 *
 * Inline alignment: the chip sits on the line's baseline (`align-baseline`)
 * and its labels are the flex items that take part in baseline alignment
 * (`self-baseline` on every text span; icons are svgs or `aria-hidden` spans
 * and stay centered). A flex container's baseline comes from its
 * baseline-aligned items, so the chip's label shares the baseline of the text
 * around it, and a list marker, which sits on that same baseline, lines up
 * with a chip at the start of the item. Without a baseline item the
 * container's baseline is the bottom of its first item, the leading icon,
 * which lifts the whole chip; `vertical-align: middle` instead depends on the
 * font's x-height and does not match CJK text either.
 *
 * The 12px label, 2px padding and border keep the chip inside a 14px line's
 * box, so a chip never pushes the line apart.
 */
export const MENTION_CHIP_CLASS =
  "inline-flex min-w-0 max-w-[min(18rem,100%)] items-center gap-1.5 rounded-md border mx-0.5 px-2 py-0.5 text-caption align-baseline [&>span:not([aria-hidden])]:self-baseline";
