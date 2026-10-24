"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeDeleteImpactOptions, knowledgeKeys, type KnowledgeBase } from "@marvis/core/knowledge";
import { useCurrentMember } from "@marvis/core/permissions";
import type { Agent } from "@marvis/core/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { PAGE_GUTTER } from "../../layout/page-header";
import { useT } from "../../i18n";
import { canAdministerWorkspace } from "../lib/permissions";
import { KnowledgeDigestSection } from "./knowledge-digest-section";
import { MaintainerAgentSelect } from "./maintainer-agent-select";

export function KnowledgeSettingsTab({
  kb,
  agents,
  isLast,
  onDeleted,
}: {
  kb: KnowledgeBase;
  agents: Agent[];
  isLast: boolean;
  onDeleted: () => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { userId, role } = useCurrentMember(wsId);
  const isAdmin = canAdministerWorkspace(role);
  const canManage = isAdmin || (!!userId && kb.created_by === userId);

  const [name, setName] = useState(kb.name);
  const [description, setDescription] = useState(kb.description);
  const [saving, setSaving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setName(kb.name);
    setDescription(kb.description);
  }, [kb.id, kb.name, kb.description]);

  const { data: impact } = useQuery(knowledgeDeleteImpactOptions(wsId, kb.id, deleteOpen));

  const refresh = () => qc.invalidateQueries({ queryKey: knowledgeKeys.all(wsId) });

  const save = async (patch: { name?: string; description?: string; maintainer_agent_id?: string | null }) => {
    setSaving(true);
    try {
      await api.updateKnowledgeBase(kb.id, patch);
      await refresh();
      toast.success(t(($) => $.settings.saved));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.settings.save_failed));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      await api.deleteKnowledgeBase(kb.id);
      await refresh();
      setDeleteOpen(false);
      toast.success(t(($) => $.delete.deleted, { name: kb.name }));
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.delete.failed));
    } finally {
      setDeleting(false);
    }
  };

  const exportZip = async () => {
    setExporting(true);
    try {
      const blob = await api.exportKnowledgeBase(kb.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${kb.slug}.zip`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.export.failed));
    } finally {
      setExporting(false);
    }
  };

  const dirty = name.trim() !== kb.name || description.trim() !== kb.description;

  return (
    <div className={`flex-1 overflow-y-auto py-6 ${PAGE_GUTTER}`}>
      <div className="flex max-w-2xl flex-col gap-8">
        <section className="flex flex-col gap-4">
          <h2 className="text-title-sm font-semibold">{t(($) => $.settings.title)}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="kb-settings-name">{t(($) => $.fields.name)}</Label>
            <Input id="kb-settings-name" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-settings-description">{t(($) => $.fields.description)}</Label>
            <Textarea
              id="kb-settings-description"
              rows={3}
              value={description}
              disabled={!canManage}
              onChange={(e) => setDescription(e.target.value)}
            />
            <p className="text-caption text-muted-foreground">{t(($) => $.fields.description_hint)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-settings-agent">{t(($) => $.fields.maintainer)}</Label>
            <MaintainerAgentSelect
              id="kb-settings-agent"
              agents={agents}
              value={kb.maintainer_agent_id}
              disabled={!canManage || saving}
              onChange={(agentId) => void save({ maintainer_agent_id: agentId ?? "" })}
            />
          </div>
          <p className="text-caption text-muted-foreground">{t(($) => $.settings.directory, { slug: kb.slug })}</p>
          {canManage ? (
            <div>
              <Button
                disabled={!dirty || !name.trim() || saving}
                aria-busy={saving}
                onClick={() => void save({ name: name.trim(), description: description.trim() })}
              >
                {t(($) => $.common.save)}
              </Button>
            </div>
          ) : (
            <p className="text-caption text-muted-foreground">{t(($) => $.settings.manage_hint)}</p>
          )}
        </section>

        <KnowledgeDigestSection agents={agents} defaultAgentId={kb.maintainer_agent_id} isAdmin={isAdmin} />

        <section className="flex flex-col gap-2">
          <h2 className="text-title-sm font-semibold">{t(($) => $.repo.title)}</h2>
          <p className="text-caption text-muted-foreground">{t(($) => $.repo.shared)}</p>
          <div className="rounded-lg border border-border p-3">
            <div className="font-medium">{t(($) => $.repo.hosted)}</div>
            <div className="text-caption text-muted-foreground">{t(($) => $.repo.hosted_hint)}</div>
          </div>
          <div className="rounded-lg border border-border p-3 opacity-60">
            <div className="font-medium">{t(($) => $.repo.external)}</div>
            <div className="text-caption text-muted-foreground">{t(($) => $.repo.external_unavailable)}</div>
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-title-sm font-semibold">{t(($) => $.export.title)}</h2>
          <div>
            <Button variant="outline" disabled={exporting} aria-busy={exporting} onClick={() => void exportZip()}>
              {t(($) => $.export.zip)}
            </Button>
          </div>
          <p className="text-caption text-muted-foreground">{t(($) => $.export.hint)}</p>
        </section>

        {isAdmin ? (
          <section className="flex items-center gap-3">
            <div className="flex-1">
              <h2 className="text-title-sm font-semibold text-destructive">{t(($) => $.delete.title)}</h2>
              <p className="text-caption text-muted-foreground">{t(($) => $.delete.hint, { slug: kb.slug })}</p>
            </div>
            <Button variant="destructive" onClick={() => { setConfirmText(""); setDeleteOpen(true); }}>
              {t(($) => $.delete.action)}
            </Button>
          </section>
        ) : null}
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.delete.confirm_title, { name: kb.name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.delete.impact, {
                slug: kb.slug,
                annotations: impact?.open_annotations ?? 0,
                changes: impact?.open_change_requests ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {impact?.last_knowledge_base || isLast ? (
            <p className="text-body text-destructive">{t(($) => $.delete.last)}</p>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="kb-delete-confirm">{t(($) => $.delete.type_name)}</Label>
            <Input id="kb-delete-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.common.cancel)}</AlertDialogCancel>
            <Button variant="destructive" disabled={confirmText !== kb.name || deleting} aria-busy={deleting} onClick={() => void remove()}>
              {t(($) => $.delete.action)}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
