"use client";

import { useState, type ReactNode } from "react";
import { Lock, Maximize2 } from "lucide-react";
import type { KbDraft } from "@marvis/core/kb";
import type { KbBuilderMode, KnowledgeBaseSchemaMode } from "@marvis/core/types";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "../../i18n";
import { KbMarkdownDialog } from "./kb-markdown-dialog";

/** Form fields a builder reply can change, for the "just updated" tag. */
export type KbDraftField = "name" | "slug" | "description" | "purpose" | "schema";

function Card({ children, focused }: { children: ReactNode; focused?: boolean }) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4",
        focused && "border-foreground/25",
      )}
    >
      {children}
    </section>
  );
}

function ExpandButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconButton type="button" variant="ghost" size="icon-xs" label={label} onClick={onClick}>
      <Maximize2 className="size-3.5" aria-hidden="true" />
    </IconButton>
  );
}

function JustUpdated() {
  const { t } = useT("kb");

  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      {t(($) => $.builder.panel.just_updated)}
    </span>
  );
}

/**
 * The right-hand configuration of the builder (designs 1.3, 1.5, 10.2–10.3):
 * name, description, slug when creating, the purpose and the schema. The
 * default schema is read-only; the custom one is edited here or enlarged.
 */
export function KbConfigPanel({
  mode,
  draft,
  onChange,
  onSchemaModeChange,
  schemaExample,
  justUpdated,
  nameError,
  slugError,
}: {
  mode: KbBuilderMode;
  draft: KbDraft;
  onChange: (patch: Partial<KbDraft>, field: KbDraftField) => void;
  onSchemaModeChange: (schemaMode: KnowledgeBaseSchemaMode) => void;
  /** Shown as the empty custom schema's placeholder: the built-in schema. */
  schemaExample?: string;
  justUpdated: ReadonlySet<KbDraftField>;
  nameError: string | null;
  slugError: string | null;
}) {
  const { t } = useT("kb");
  const [expanded, setExpanded] = useState<"purpose" | "schema" | null>(null);
  const schemaReadOnly = draft.schemaMode === "default";

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-title-sm font-semibold">{t(($) => $.builder.panel.title)}</h2>

      <Card>
        <h3 className="text-label font-semibold">{t(($) => $.builder.panel.basics)}</h3>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kb-draft-name" className="font-normal text-muted-foreground">
            {t(($) => $.builder.panel.name)}
          </Label>
          <Input
            id="kb-draft-name"
            value={draft.name}
            placeholder={t(($) => $.builder.panel.generated_placeholder)}
            aria-invalid={!!nameError}
            onChange={(e) => onChange({ name: e.target.value }, "name")}
          />
          {nameError && <p className="text-caption text-destructive">{nameError}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="kb-draft-description" className="font-normal text-muted-foreground">
            {t(($) => $.builder.panel.description)}
          </Label>
          <Input
            id="kb-draft-description"
            value={draft.description}
            placeholder={t(($) => $.builder.panel.generated_placeholder)}
            onChange={(e) => onChange({ description: e.target.value }, "description")}
          />
        </div>
        {mode === "create" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-draft-slug" className="font-normal text-muted-foreground">
              {t(($) => $.builder.panel.slug)}
            </Label>
            <Input
              id="kb-draft-slug"
              value={draft.slug}
              className="font-mono"
              placeholder={t(($) => $.builder.panel.slug_placeholder)}
              aria-invalid={!!slugError}
              onChange={(e) => onChange({ slug: e.target.value }, "slug")}
            />
            {slugError && <p className="text-caption text-destructive">{slugError}</p>}
          </div>
        )}
      </Card>

      <Card focused={justUpdated.has("purpose")}>
        <div className="flex items-center gap-2">
          <h3 className="flex-1 text-label font-semibold">{t(($) => $.builder.panel.purpose)}</h3>
          {justUpdated.has("purpose") && <JustUpdated />}
          <ExpandButton label={t(($) => $.builder.panel.expand_edit)} onClick={() => setExpanded("purpose")} />
        </div>
        <Textarea
          aria-label={t(($) => $.builder.panel.purpose)}
          rows={5}
          value={draft.purpose}
          placeholder={t(($) => $.builder.panel.purpose_placeholder)}
          className="font-mono text-caption leading-6"
          onChange={(e) => onChange({ purpose: e.target.value }, "purpose")}
        />
      </Card>

      <Card focused={justUpdated.has("schema")}>
        <div className="flex items-center gap-2">
          <h3 className="text-label font-semibold">{t(($) => $.builder.panel.schema)}</h3>
          <Tabs
            value={draft.schemaMode}
            onValueChange={(next) => onSchemaModeChange(next as KnowledgeBaseSchemaMode)}
          >
            <TabsList aria-label={t(($) => $.builder.panel.schema_mode)} className="h-8">
              <TabsTrigger value="default">{t(($) => $.builder.panel.schema_default)}</TabsTrigger>
              <TabsTrigger value="custom">{t(($) => $.builder.panel.schema_custom)}</TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          {justUpdated.has("schema") && <JustUpdated />}
          {schemaReadOnly && (
            <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-micro text-muted-foreground">
              <Lock className="size-3" aria-hidden="true" />
              {t(($) => $.builder.panel.read_only)}
            </span>
          )}
          <ExpandButton
            label={schemaReadOnly ? t(($) => $.builder.panel.expand_view) : t(($) => $.builder.panel.expand_edit)}
            onClick={() => setExpanded("schema")}
          />
        </div>
        {schemaReadOnly && (
          <p className="text-caption text-faint-foreground">{t(($) => $.builder.panel.schema_default_hint)}</p>
        )}
        <Textarea
          aria-label={t(($) => $.builder.panel.schema)}
          rows={14}
          value={draft.schema}
          readOnly={schemaReadOnly}
          placeholder={schemaExample || t(($) => $.builder.panel.schema_placeholder)}
          className={cn("font-mono text-caption leading-6", schemaReadOnly && "bg-muted text-muted-foreground")}
          onChange={(e) => onChange({ schema: e.target.value }, "schema")}
        />
      </Card>

      {expanded && (
        <KbMarkdownDialog
          open
          onOpenChange={(open) => {
            if (!open) setExpanded(null);
          }}
          title={expanded === "purpose" ? t(($) => $.builder.panel.purpose) : t(($) => $.builder.panel.schema)}
          value={expanded === "purpose" ? draft.purpose : draft.schema}
          readOnly={expanded === "schema" && schemaReadOnly}
          onDone={(value) =>
            expanded === "purpose" ? onChange({ purpose: value }, "purpose") : onChange({ schema: value }, "schema")
          }
        />
      )}
    </div>
  );
}
