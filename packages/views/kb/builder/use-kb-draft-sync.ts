"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fromStoredKbDraft, storedKbDraftsEqual, toStoredKbDraft, type KbDraft } from "@marvis/core/kb";
import { api } from "@marvis/core/api";
import type { StoredKbDraft } from "@marvis/core/types";

/** How long editing pauses before the configuration is written back. */
const AUTOSAVE_DELAY_MS = 800;

/**
 * Keeps one builder conversation's right-hand configuration in sync with the
 * server, like the agent builder's useBuilderDraftSync: restore it once
 * everything it depends on has arrived, then autosave edits. Autosave is armed
 * only after the restore, so an empty initial form can never overwrite a
 * stored configuration; the restore also gates merging builder replies.
 */
export function useKbDraftSync(options: {
  sessionId: string;
  /** The saved configuration, or null when none was ever saved. */
  stored: StoredKbDraft | null | undefined;
  /** False while the stored configuration or the seed is still loading. */
  ready: boolean;
  /** The form for a conversation with nothing saved. */
  seed: () => KbDraft;
  /** Read-only schema text for a saved default-mode configuration. */
  defaultSchema: string;
  draft: KbDraft;
  setDraft: Dispatch<SetStateAction<KbDraft>>;
}) {
  const { sessionId, stored, ready, seed, defaultSchema, draft, setDraft } = options;

  const [restored, setRestored] = useState(false);
  const [appliedMessageId, markApplied] = useState<string | null>(null);
  const savedRef = useRef<StoredKbDraft | null>(null);

  useEffect(() => {
    if (!sessionId || restored || !ready) return;

    if (stored) {
      markApplied(stored.applied_message_id);
      savedRef.current = stored;
      setDraft(fromStoredKbDraft(stored, defaultSchema));
    } else {
      setDraft(seed());
    }
    setRestored(true);
  }, [defaultSchema, ready, restored, seed, sessionId, setDraft, stored]);

  // What the debounce holds, so unmounting inside the window still saves it.
  const pendingRef = useRef<StoredKbDraft | null>(null);
  const save = useCallback(
    (next: StoredKbDraft) => {
      savedRef.current = next;
      pendingRef.current = null;
      void api.saveKbBuilderDraft(sessionId, next).catch(() => {
        // Best-effort: the next edit retries.
        savedRef.current = null;
      });
    },
    [sessionId],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!sessionId || !restored) return;
    const next = toStoredKbDraft(draft, appliedMessageId);
    if (savedRef.current && storedKbDraftsEqual(savedRef.current, next)) return;

    pendingRef.current = next;
    const timer = setTimeout(() => save(next), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [appliedMessageId, draft, restored, save, sessionId]);

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      if (pending) saveRef.current(pending);
    },
    [],
  );

  /** Stops autosaving, for a conversation that is being retired. */
  const cancelPending = useCallback(() => {
    pendingRef.current = null;
  }, []);

  return { restored, appliedMessageId, markApplied, cancelPending };
}
