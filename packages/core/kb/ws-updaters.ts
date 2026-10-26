import type { QueryClient } from "@tanstack/react-query";
import { kbKeys } from "./queries";

/**
 * Everything an annotation change can move: the lists, the counts on the
 * knowledge base list and home page, and the page's and tree's counters.
 */
export function invalidateKbAnnotations(qc: QueryClient, wsId: string) {
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "annotations"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "home"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "page"] });
  void qc.invalidateQueries({ queryKey: [...kbKeys.all(wsId), "level"] });
  void qc.invalidateQueries({ queryKey: kbKeys.bases(wsId) });
}
