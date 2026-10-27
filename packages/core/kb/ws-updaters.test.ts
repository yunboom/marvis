// @vitest-environment node
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { kbKeys } from "./queries";
import { invalidateKbAnnotations, invalidateKbBase, invalidateKbDraft, invalidateKbMergeRequests } from "./ws-updaters";

const WS = "ws-1";

function seeded(...keys: (readonly unknown[])[]) {
  const qc = new QueryClient();
  for (const key of keys) qc.setQueryData(key, {});
  return qc;
}

function invalidated(qc: QueryClient, key: readonly unknown[]): boolean {
  return qc.getQueryState(key)?.isInvalidated ?? false;
}

// Mention cards read merge requests and annotations by id; the events that
// change them must refresh those cards too.
describe("mention card queries", () => {
  it("refresh a merge request read by id with the reviews", () => {
    const key = kbKeys.reviewById(WS, "mr-1");
    const qc = seeded(key);
    invalidateKbMergeRequests(qc, WS);
    expect(invalidated(qc, key)).toBe(true);

    const drafted = seeded(key);
    invalidateKbDraft(drafted, WS, "d-1");
    expect(invalidated(drafted, key)).toBe(true);
  });

  it("refresh an annotation read by id on annotation changes", () => {
    const key = kbKeys.annotation(WS, "a-1");
    const qc = seeded(key);
    invalidateKbAnnotations(qc, WS);
    expect(invalidated(qc, key)).toBe(true);
  });
});

describe("invalidateKbDraft", () => {
  it("refreshes the published read of each touched page for its draft bar", () => {
    const touched = kbKeys.page(WS, "p-1", "");
    const other = kbKeys.page(WS, "p-2", "");
    const throughDraft = kbKeys.page(WS, "p-2", "d-1");
    const qc = seeded(touched, other, throughDraft);
    invalidateKbDraft(qc, WS, "d-1", ["p-1"]);
    expect(invalidated(qc, touched)).toBe(true);
    expect(invalidated(qc, other)).toBe(false);
    expect(invalidated(qc, throughDraft)).toBe(true);
  });

  it("refreshes that draft's changes and no other draft's", () => {
    const own = kbKeys.draft(WS, "d-1");
    const other = kbKeys.draft(WS, "d-2");
    const qc = seeded(own, other);
    invalidateKbDraft(qc, WS, "d-1");
    expect(invalidated(qc, own)).toBe(true);
    expect(invalidated(qc, other)).toBe(false);
  });
});

describe("invalidateKbBase", () => {
  it("refreshes the home page when a knowledge base is configured", () => {
    const home = kbKeys.home(WS, "team");
    const qc = seeded(home);
    invalidateKbBase(qc, WS, false);
    expect(invalidated(qc, home)).toBe(true);
  });
});
