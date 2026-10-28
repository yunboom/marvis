"use client";

/**
 * MentionView — NodeView for rendering @mentions inline in the editor.
 *
 * Member/agent mentions: plain "@Name" text with .mention class styling.
 * Issue/project mentions render the same navigable chips as readonly content
 * (IssueMentionCard / ProjectMentionCard), so click behavior — plain click,
 * modifier click, middle click — cannot drift between an editing and a
 * readonly surface. The editor's ProseMirror click handler skips anything
 * inside `[data-node-view-wrapper]`, so the AppLink inside the card owns the
 * click alone.
 *
 * Chip alignment: the chip sits on the text baseline (see MENTION_CHIP_CLASS).
 * The wrapper is the outermost inline element, so it carries
 * `mention-chip-node`, which resets the editor's `vertical-align: middle` on
 * node views to the baseline; otherwise the wrapper would shift the chip.
 */

import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { IssueMentionCard } from "../../issues/components/issue-mention-card";
import { ProjectMentionCard } from "../../projects/components/project-mention-card";
import { KbMention, isKbMentionType } from "../../kb/components/kb-mention-cards";

export function MentionView({ node }: NodeViewProps) {
  const { type, id, label } = node.attrs;

  // stopPropagation mirrors the readonly renderer's mention wrappers: a chip
  // click must not reach surrounding click handlers.
  if (type === "issue") {
    return (
      <NodeViewWrapper
        as="span"
        className="mention-chip-node inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <IssueMentionCard issueId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  if (type === "project") {
    return (
      <NodeViewWrapper
        as="span"
        className="mention-chip-node inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <ProjectMentionCard projectId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  if (isKbMentionType(type)) {
    return (
      <NodeViewWrapper
        as="span"
        className="mention-chip-node inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <KbMention type={type} id={id} label={label} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper as="span" className="inline">
      <span className="mention">@{label ?? id}</span>
    </NodeViewWrapper>
  );
}
