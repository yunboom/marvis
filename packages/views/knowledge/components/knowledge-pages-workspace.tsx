"use client";

import { useState } from "react";
import type { KnowledgeAnnotation, KnowledgeBase } from "@marvis/core/knowledge";
import { Button } from "@marvis/ui/components/ui/button";
import { useT } from "../../i18n";
import { useAnnotationSlots } from "./knowledge-annotations";
import { KnowledgePageEditor } from "./knowledge-page-editor";
import { KnowledgePagesTab, type KnowledgeReaderSlots } from "./knowledge-pages-tab";

/** The pages tab with its interactive layers: annotations and manual edit. */
export function KnowledgePagesWorkspace({
  kb,
  onOpenChange,
  onSubmitAnnotations,
}: {
  kb: KnowledgeBase;
  onOpenChange: (number: number) => void;
  onSubmitAnnotations?: (annotations: KnowledgeAnnotation[]) => void;
}) {
  const { t } = useT("knowledge");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const annotationSlots = useAnnotationSlots(kb, onSubmitAnnotations);

  const slots: KnowledgeReaderSlots = {
    ...annotationSlots,
    headerActions: (page) => (
      <>
        {annotationSlots.headerActions?.(page)}
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
