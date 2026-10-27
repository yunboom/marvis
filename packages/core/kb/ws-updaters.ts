import type { QueryClient } from "@tanstack/react-query";
import { kbKeys } from "./queries";

/**
 * Everything an annotation change can move: the lists, the counts on the
 * knowledge base list and home page, and the page's and tree's counters.
 */
export function invalidateKbAnnotations(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "annotations"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "annotation"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "home"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "level"] });
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}

/** Job lists and job pages: a job started, linked, submitted or discarded. */
export function invalidateKbJobs(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "jobs"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "job"] });
}

/**
 * A draft took writes: the job pages (their right-hand diff and checks) and
 * every tree level and page read through that draft. Tree and page keys end
 * with the draft they were read through.
 */
export function invalidateKbDraft(qc: QueryClient, wsId: string, draftId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "job"] });
  // A merge request's diff follows its draft; its key has no draft id.
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "review"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "jobs"] });
  for (const scope of ["level", "page"] as const) {
    void qc.invalidateQueries({
      queryKey: [...kbKeys.all(wsId), scope],
      predicate: (query) => query.queryKey[query.queryKey.length - 1] === draftId,
    });
  }
}

/**
 * A merge request opened: jobs turn read-only, and the home page, knowledge
 * base list and reading pages count it as waiting for review.
 */
export function invalidateKbMergeRequests(qc: QueryClient, wsId: string) {
  invalidateKbJobs(qc, wsId);
  void qc.invalidateQueries({ queryKey: kbKeys.reviews(wsId) });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "review"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "home"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}

/**
 * A merge request was merged or closed: on top of what an opened one moves,
 * the mainline changed (pages, tree levels, history, search) and the
 * annotations it handled moved on.
 */
export function invalidateKbMainline(qc: QueryClient, wsId: string) {
  invalidateKbMergeRequests(qc, wsId);
  invalidateKbAnnotations(qc, wsId);
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "history"] });
  void qc.invalidateQueries({ queryKey: kbKeys.searches(wsId) });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "graph"] });
}

/**
 * A knowledge base was created, configured or deleted: the list and the
 * detail. A deleted one also drops everything cached under it.
 */
export function invalidateKbBase(qc: QueryClient, wsId: string, deleted: boolean) {
  if (deleted) {
    void qc.invalidateQueries({ queryKey: kbKeys.all(wsId) });
    return;
  }
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}

/** A review comment: the thread, and the detail's agent-at-work state. */
export function invalidateKbMrComments(qc: QueryClient, wsId: string, number: number) {
  void qc.invalidateQueries({ queryKey: kbKeys.review(wsId, number) });
}
