"use client";

import { useState } from "react";
import { X, Plus, Filter, ExternalLink, CircleAlert } from "lucide-react";
import { cn } from "@marvis/ui/lib/utils";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@marvis/ui/components/ui/popover";
import type { WebhookEventFilter } from "@marvis/core/types";
import { useT } from "../../i18n";
import { DOCS_LINKS_ENABLED } from "../../common/docs-locale";

interface WebhookEventFilterSectionProps {
  filters: WebhookEventFilter[];
  onChange: (filters: WebhookEventFilter[]) => void;
}

export function WebhookEventFilterSection({
  filters,
  onChange,
}: WebhookEventFilterSectionProps) {
  const { t, i18n } = useT("autopilots");
  const [newEvent, setNewEvent] = useState("");
  const [newActions, setNewActions] = useState("");
  const docsHref = i18n.language?.startsWith("zh")
    ? `https://marvis.ai/docs/zh/autopilots#${encodeURIComponent("事件过滤")}`
    : i18n.language?.startsWith("fr")
      ? `https://marvis.ai/docs/fr/autopilots#${encodeURIComponent("filtres-dévénements")}`
      : "https://marvis.ai/docs/autopilots#event-filters";

  const addFilter = () => {
    const event = newEvent.trim();
    if (!event) return;
    const actions = newActions
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a.length > 0);
    const next: WebhookEventFilter = { event };
    if (actions.length > 0) next.actions = actions;
    onChange([...filters, next]);
    setNewEvent("");
    setNewActions("");
  };

  const removeFilter = (idx: number) => {
    onChange(filters.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-micro font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        <Filter className="size-3" />
        {t(($) => $.dialog.event_filter_label)}
        <EventFilterHelp />
        {DOCS_LINKS_ENABLED && (
          <a
            href={docsHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t(($) => $.dialog.event_filter_docs_link_label)}
            title={t(($) => $.dialog.event_filter_docs_link_label)}
            className="ml-0.5 inline-flex items-center text-faint-foreground hover:text-foreground transition-colors"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>

      {filters.length > 0 && (
        <div className="space-y-1">
          {filters.map((f, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-caption"
            >
              <span className="font-mono font-medium text-foreground">
                {f.event}
              </span>
              {f.actions && f.actions.length > 0 && (
                <span className="text-muted-foreground">
                  : {f.actions.join(", ")}
                </span>
              )}
              <TooltipHint label={t(($) => $.dialog.event_filter_remove_label)}>
                <button
                  type="button"
                  onClick={() => removeFilter(idx)}
                  aria-label={t(($) => $.dialog.event_filter_remove_label)}
                  className="ml-auto rounded-xs p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                >
                  <X className="size-3" />
                </button>
              </TooltipHint>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newEvent}
          onChange={(e) => setNewEvent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFilter();
            }
          }}
          placeholder={t(($) => $.dialog.event_filter_event_placeholder)}
          className="flex-1 min-w-0 rounded-md border bg-background px-2.5 py-1.5 text-caption font-mono outline-none focus:ring-1 focus:ring-ring"
        />
        <input
          type="text"
          value={newActions}
          onChange={(e) => setNewActions(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addFilter();
            }
          }}
          placeholder={t(($) => $.dialog.event_filter_actions_placeholder)}
          className="w-28 rounded-md border bg-background px-2.5 py-1.5 text-caption outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          type="button"
          onClick={addFilter}
          disabled={!newEvent.trim()}
          className={cn(
            "inline-flex shrink-0 items-center justify-center gap-1 rounded-md border px-2.5 py-1.5 text-caption font-medium transition-colors",
            newEvent.trim()
              ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer"
              : "bg-muted text-muted-foreground cursor-not-allowed",
          )}
        >
          <Plus className="size-3.5" />
          {t(($) => $.dialog.event_filter_add)}
        </button>
      </div>
      <p className="text-micro text-muted-foreground">
        {t(($) => $.dialog.event_filter_hint)}
      </p>
    </div>
  );
}

// Field names mirror inferEvent / webhookActionCandidates in
// server/internal/handler/autopilot_webhook.go; keep them in sync.
const EVENT_HEADERS = ["X-GitHub-Event", "X-Gitlab-Event", "X-Event-Type"];
const EVENT_BODY_FIELDS = ["event", "type"];
const ACTION_BODY_FIELDS = ["action", "state", "conclusion", "status"];

function EventFilterHelp() {
  const { t } = useT("autopilots");
  const label = t(($) => $.dialog.event_filter_help_label);
  const url = t(($) => $.dialog.event_filter_help_url_placeholder);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={200}
        aria-label={label}
        className="ml-0.5 inline-flex cursor-pointer items-center rounded-full text-faint-foreground transition-colors hover:text-foreground data-popup-open:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <CircleAlert className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        aria-label={label}
        initialFocus={false}
        className="w-96 max-w-[calc(100vw-16px)] gap-3 p-3 text-caption"
      >
        <p className="text-foreground">
          {t(($) => $.dialog.event_filter_help_intro)}
        </p>

        <dl className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2 gap-y-1.5">
          <dt className="row-span-2 font-medium text-foreground">
            {t(($) => $.dialog.event_filter_help_event_label)}
          </dt>
          <dd className="text-muted-foreground">
            {t(($) => $.dialog.event_filter_help_header)}
          </dd>
          <dd>
            <CodeChips values={EVENT_HEADERS} />
          </dd>
          <dd className="text-muted-foreground">
            {t(($) => $.dialog.event_filter_help_body)}
          </dd>
          <dd>
            <CodeChips values={EVENT_BODY_FIELDS} />
          </dd>
          <dt className="font-medium text-foreground">
            {t(($) => $.dialog.event_filter_help_action_label)}
          </dt>
          <dd className="text-muted-foreground">
            {t(($) => $.dialog.event_filter_help_body)}
          </dd>
          <dd>
            <CodeChips values={ACTION_BODY_FIELDS} />
          </dd>
        </dl>

        <HelpExample
          title={t(($) => $.dialog.event_filter_help_example_custom)}
          request={`curl -X POST ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"event": "deploy", "status": "failed"}'`}
          event="deploy"
          action="failed"
          note={t(($) => $.dialog.event_filter_help_custom_note)}
        />
        <HelpExample
          title={t(($) => $.dialog.event_filter_help_example_github)}
          request={`X-GitHub-Event: workflow_run\n\n{"action": "completed", "workflow_run": {...}}`}
          event="workflow_run"
          action="completed"
        />
      </PopoverContent>
    </Popover>
  );
}

function CodeChips({ values }: { values: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((value) => (
        <code
          key={value}
          className="rounded-sm bg-muted px-1 font-mono text-micro text-foreground"
        >
          {value}
        </code>
      ))}
    </span>
  );
}

function HelpExample({
  title,
  request,
  event,
  action,
  note,
}: {
  title: string;
  request: string;
  event: string;
  action: string;
  note?: string;
}) {
  const { t } = useT("autopilots");

  return (
    <div className="space-y-1.5">
      <div className="font-medium text-foreground">{title}</div>
      <pre className="overflow-x-auto rounded-md bg-muted px-2.5 py-2 font-mono text-micro leading-relaxed text-foreground">
        {request}
      </pre>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
        <span>{t(($) => $.dialog.event_filter_help_match)}</span>
        <span>{t(($) => $.dialog.event_filter_help_event_label)}</span>
        <code className="rounded-sm border bg-background px-1.5 font-mono text-micro text-foreground">
          {event}
        </code>
        <span>{t(($) => $.dialog.event_filter_help_action_label)}</span>
        <code className="rounded-sm border bg-background px-1.5 font-mono text-micro text-foreground">
          {action}
        </code>
      </div>
      {note && <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}
