"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import { useWorkspaceId } from "@marvis/core/hooks";
import { knowledgeKeys, type KnowledgeBase } from "@marvis/core/knowledge";
import type { Agent } from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { MaintainerAgentSelect } from "./maintainer-agent-select";

export function CreateKnowledgeDialog({
  open,
  onOpenChange,
  agents,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: Agent[];
  onCreated: (kb: KnowledgeBase) => void;
}) {
  const { t } = useT("knowledge");
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const kb = await api.createKnowledgeBase({
        name: name.trim(),
        description: description.trim(),
        maintainer_agent_id: agentId,
      });
      await qc.invalidateQueries({ queryKey: knowledgeKeys.bases(wsId) });
      toast.success(t(($) => $.create.created, { name: kb.name }));
      setName("");
      setDescription("");
      setAgentId(null);
      onOpenChange(false);
      onCreated(kb);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t(($) => $.create.failed));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.create.title)}</DialogTitle>
          <DialogDescription>{t(($) => $.create.description)}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !submitting) void submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="kb-create-name">{t(($) => $.fields.name)}</Label>
            <Input
              id="kb-create-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(($) => $.fields.name_placeholder)}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-create-description">{t(($) => $.fields.description)}</Label>
            <Textarea
              id="kb-create-description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t(($) => $.fields.description_placeholder)}
            />
            <p className="text-caption text-muted-foreground">{t(($) => $.fields.description_hint)}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-create-agent">{t(($) => $.fields.maintainer)}</Label>
            <MaintainerAgentSelect id="kb-create-agent" agents={agents} value={agentId} onChange={setAgentId} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t(($) => $.common.cancel)}
            </Button>
            <Button type="submit" disabled={!name.trim() || submitting} aria-busy={submitting}>
              {t(($) => $.create.submit)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
