"use client";

import { useMemo } from "react";
import type { KbJobStarter } from "@marvis/core/types";
import { escapeMarkdownLabel } from "../../editor/utils/escape-markdown-label";
import { useT } from "../../i18n";

/**
 * What a member sends to start a knowledge base job. Like chat conversation
 * starters, every prompt here is sent as a normal, visible message: what the
 * member sees is exactly what the agent receives. This module is the only
 * place job requests are written.
 */

/** The opener cards of a new job (design 9.2); two of them schedule runs. */
export const KB_JOB_STARTER_CARDS = [
  { key: "ingest", starter: "ingest" },
  { key: "health", starter: "health" },
  { key: "merge", starter: "merge" },
  { key: "annotations", starter: "annotations" },
  { key: "schedule_ingest", starter: "schedule" },
  { key: "schedule_health", starter: "schedule" },
] as const satisfies readonly { key: string; starter: KbJobStarter }[];

export type KbJobStarterCardKey = (typeof KB_JOB_STARTER_CARDS)[number]["key"];

/** A starter card: `label` and `description` show on the card, `prompt` is sent. */
export interface KbJobStarterPrompt {
  key: KbJobStarterCardKey;
  starter: KbJobStarter;
  label: string;
  description: string;
  prompt: string;
}

/** The knowledge base a request names. */
export interface KbJobPromptBase {
  id: string;
  name: string;
}

/** What an entry point brought into a new job, resolved for display. */
export interface KbJobRequestContext {
  /** The checked page, or the parent of a new page. */
  page?: { id: string; title: string };
  /** Annotations, each named by where it sits (page title or knowledge base). */
  annotations?: { id: string; where: string }[];
  /** raw:// uris of uploaded files. */
  sources?: string[];
  /** What the member typed at the entry point. */
  text?: string;
}

/** A knowledge base link; renders as a card and notifies no one. */
export function kbMentionLink(base: KbJobPromptBase): string {
  return `[${escapeMarkdownLabel(base.name)}](mention://kb/${base.id})`;
}

function rawFileName(uri: string): string {
  const path = uri.split("#")[0] ?? uri;
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** The starter cards of a new job for this knowledge base. */
export function useKbJobStarters(base: KbJobPromptBase): KbJobStarterPrompt[] {
  const { t } = useT("kb");

  return useMemo(() => {
    const kb = kbMentionLink(base);

    return KB_JOB_STARTER_CARDS.map((card) => ({
      key: card.key,
      starter: card.starter,
      label: t(($) => $.job.starters[card.key].title),
      description: t(($) => $.job.starters[card.key].description),
      prompt: t(($) => $.job.prompts.starters[card.key], { kb }),
    }));
  }, [base, t]);
}

/**
 * Writes the requests entry points start jobs with: a lead sentence naming
 * the knowledge base and the operation, the brought-in context as links,
 * then what the member typed.
 */
export function useKbJobRequests() {
  const { t } = useT("kb");

  return useMemo(() => {
    const compose = (starter: KbJobStarter, base: KbJobPromptBase, context: KbJobRequestContext): string => {
      const kb = kbMentionLink(base);
      const text = context.text?.trim() ?? "";
      const parts: string[] = [];

      if (starter === "ingest" && context.sources?.length) {
        parts.push(t(($) => $.job.prompts.leads.ingest, { kb }));
        parts.push(context.sources.map((uri) => `- \`${rawFileName(uri)}\``).join("\n"));
      } else if (starter === "annotations" && context.annotations?.length) {
        parts.push(t(($) => $.job.prompts.leads.annotations, { kb }));
        parts.push(
          context.annotations
            .map((a) => {
              const label = t(($) => $.job.prompts.annotation_label, { where: a.where });
              return `- [${escapeMarkdownLabel(label)}](mention://kb_annotation/${a.id})`;
            })
            .join("\n"),
        );
      } else if ((starter === "health" || starter === "new_page") && context.page) {
        parts.push(
          starter === "health"
            ? t(($) => $.job.prompts.leads.health_page, { kb })
            : t(($) => $.job.prompts.leads.new_page, { kb }),
        );
        parts.push(`[${escapeMarkdownLabel(context.page.title)}](mention://kb_page/${context.page.id})`);
      }

      if (text) parts.push(text);

      return parts.join("\n\n");
    };

    /** Re-check every page past its review date. */
    const staleAll = (base: KbJobPromptBase): string =>
      t(($) => $.job.prompts.leads.stale_all, { kb: kbMentionLink(base) });

    return { compose, staleAll };
  }, [t]);
}
