"use client";

import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useWorkspacePaths } from "@marvis/core/paths";
import { kbBaseListOptions, pickEntryKnowledgeBase, useKbLastOpenedStore } from "@marvis/core/kb";
import { buttonVariants } from "@marvis/ui/components/ui/button";
import { Skeleton } from "@marvis/ui/components/ui/skeleton";
import { cn } from "@marvis/ui/lib/utils";
import { AppLink, useNavigation } from "../../navigation";
import { CollectionPageHeader, CollectionPageState } from "../../layout/collection-page";
import { ROUTE_ICON_COMPONENTS } from "../../layout/route-icon-components";
import { useT } from "../../i18n";

const KbIcon = ROUTE_ICON_COMPONENTS.Layers;

/**
 * The knowledge base entry (`/kb`, design 1.11): opens the home page of the
 * knowledge base last opened in this workspace, or of the earliest created
 * one. Replaces itself so the entry leaves no history entry behind. A
 * workspace without knowledge bases gets the empty state (design 1.4).
 */
export function KbEntryPage() {
  const { t } = useT("kb");
  const wsId = useWorkspaceId();
  const p = useWorkspacePaths();
  const navigation = useNavigation();
  const { data: bases = [], isPending } = useQuery(kbBaseListOptions(wsId));
  const lastOpenedId = useKbLastOpenedStore((state) => state.byWorkspace[wsId]);

  const target = pickEntryKnowledgeBase(bases, lastOpenedId);
  const targetPath = target ? p.kbBase(target.slug) : "";

  // The adapter may be a new object on every render; replace only once per target.
  const replacedTo = useRef("");
  useEffect(() => {
    if (!targetPath || replacedTo.current === targetPath) return;

    replacedTo.current = targetPath;
    navigation.replace(targetPath);
  }, [navigation, targetPath]);

  if (isPending || target) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <CollectionPageHeader icon={KbIcon} title={t(($) => $.list.title)} />
        <div className="flex flex-col gap-2 px-4 py-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CollectionPageHeader icon={KbIcon} title={t(($) => $.list.title)} />
      <div className="flex flex-1 items-center justify-center">
        <CollectionPageState
          icon={KbIcon}
          title={t(($) => $.list.empty_title)}
          description={t(($) => $.list.empty_description)}
          actions={
            <AppLink
              href={p.kbNew()}
              className={cn(buttonVariants({ size: "sm" }), "h-9 gap-1.5 pr-4 pl-3.5 text-body")}
            >
              <Plus aria-hidden="true" className="size-4" />
              {t(($) => $.list.new_button)}
            </AppLink>
          }
        />
      </div>
    </div>
  );
}
