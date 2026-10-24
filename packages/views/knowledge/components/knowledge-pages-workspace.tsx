"use client";

import { useState } from "react";
import type { KnowledgeBase } from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { useT } from "../../i18n";
import { KnowledgePageEditor } from "./knowledge-page-editor";
import { KnowledgePagesTab, type KnowledgeReaderSlots } from "./knowledge-pages-tab";

/** The pages tab with its interactive layers (manual edit; annotations plug in here too). */
export function KnowledgePagesWorkspace({
  kb,
  onOpenChange,
  extraSlots,
}: {
  kb: KnowledgeBase;
  onOpenChange: (number: number) => void;
  extraSlots?: KnowledgeReaderSlots;
}) {
  const { t } = useT("knowledge");
  const [editingPath, setEditingPath] = useState<string | null>(null);

  const slots: KnowledgeReaderSlots = {
    ...extraSlots,
    headerActions: (page) => (
      <>
        {extraSlots?.headerActions?.(page)}
        <Button size="xs" variant="ghost" onClick={() => setEditingPath(page.path)}>
          {t(($) => $.edit.action)}
        </Button>
      </>
    ),
    override: (page) =>
      editingPath === page.path ? (
        <KnowledgePageEditor page={page} onDone={() => setEditingPath(null)} onSubmitted={onOpenChange} />
      ) : null,
  };

  return <KnowledgePagesTab kb={kb} slots={slots} />;
}
