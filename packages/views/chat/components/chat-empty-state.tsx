"use client";

import { Settings2 } from "lucide-react";
import { selectConversationStarters } from "@marvis/core/agents";
import type { Agent } from "@marvis/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import {
  ConversationStarterList,
  useFallbackConversationStarters,
} from "./conversation-starter-list";

/** Empty compose placeholder shown before the first user message. */
export function EmptyState({
  agent,
  hasSessions = true,
  onPickPrompt,
  customizeHref = null,
}: {
  agent: Agent | null;
  hasSessions?: boolean;
  onPickPrompt: (prompt: string) => void;
  /**
   * Where "customize" sends this viewer, or `null` to hide the affordance.
   * The container resolves it: only someone who may edit THIS agent on a
   * backend that persists conversation starters gets a link. Keeping it a prop
   * leaves this component presentational — and keeps the link out of the DOM
   * entirely for readers, rather than rendering a disabled tease.
   */
  customizeHref?: string | null;
}) {
  const { t } = useT("chat");
  const description = agent?.description?.trim();
  const fallbackStarters = useFallbackConversationStarters();
  const { starters } = selectConversationStarters(
    agent?.conversation_starters,
    fallbackStarters,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center-safe gap-5 overflow-y-auto px-6 py-8">
      {agent && (
        <ActorAvatar
          actorType="agent"
          actorId={agent.id}
          size="2xl"
        />
      )}
      <div className="max-w-100 space-y-1 text-center">
        <h3 className="mb-1 text-title-lg font-semibold">
          {agent
            ? t(($) => $.empty_state.chat_with_named, { name: agent.name })
            : t(($) => $.empty_state.first_time_title)}
        </h3>
        {description && (
          <p className="text-body leading-relaxed text-muted-foreground">{description}</p>
        )}
        {!hasSessions && (
          <p className="text-body leading-relaxed text-muted-foreground">
            {t(($) => $.empty_state.first_time_actions)}
          </p>
        )}
      </div>
      {agent ? (
        <div
          className="w-full max-w-100 space-y-2"
          aria-label={t(($) => $.conversation_starters.aria_label)}
        >
          <ConversationStarterList starters={starters} onPick={onPickPrompt} />
          {customizeHref ? (
            <div className="flex justify-center pt-1">
              <AppLink
                href={customizeHref}
                className="inline-flex items-center gap-1.5 text-label text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:text-foreground"
              >
                <Settings2 className="size-3.5" aria-hidden="true" />
                {t(($) => $.conversation_starters.customize)}
              </AppLink>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
