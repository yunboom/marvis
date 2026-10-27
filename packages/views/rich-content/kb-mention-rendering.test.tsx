/**
 * Knowledge base links in rendered Markdown (spec 7.14): each `mention://kb*`
 * type reaches the knowledge base card with its id (a page link keeps its
 * block) and the link text, instead of the plain member-mention span.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NavigationProvider } from "../navigation/context";
import type { NavigationAdapter } from "../navigation/types";

vi.mock("../issues/hooks", () => ({
  useResolveIssueIdentifier: () => null,
}));

vi.mock("../i18n", async () => {
  const editor = (await import("../locales/en/editor.json")).default;
  return {
    useT: () => ({
      t: (select: (bundle: typeof editor) => string) => select(editor),
    }),
    useTimeAgo: () => "just now",
  };
});

vi.mock("@marvis/core/api", () => ({
  api: { getAttachmentTextContent: vi.fn() },
  PreviewTooLargeError: class extends Error {},
  PreviewUnsupportedError: class extends Error {},
}));

vi.mock("@marvis/core/paths", () => ({
  useWorkspacePaths: () => ({}),
  useWorkspaceSlug: () => "acme",
}));

vi.mock("../editor/link-hover-card", () => ({
  useLinkHover: () => ({}),
  LinkHoverCard: () => null,
}));

vi.mock("../kb/components/kb-mention-cards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kb/components/kb-mention-cards")>();
  return {
    ...actual,
    KbMention: ({ type, id, label }: { type: string; id: string; label?: string }) => (
      <span data-testid="kb-mention" data-type={type} data-id={id}>
        {label}
      </span>
    ),
  };
});

import { RichContent } from "./rich-content";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

describe("knowledge base mentions in RichContent", () => {
  it("renders every knowledge base link type as its card", () => {
    render(
      <NavigationProvider value={adapter}>
        <RichContent
          content={[
            "建好了 [支付排障手册](mention://kb/kb-1)，",
            "依据 [支付回调](mention://kb_page/page-1#b8Xz)，",
            "已提交 [#16 去重键…](mention://kb_mr/mr-1)，",
            "记了 [批注 · 支付回调](mention://kb_annotation/a-1)。",
          ].join("")}
        />
      </NavigationProvider>,
    );

    const cards = screen.getAllByTestId("kb-mention");
    expect(cards.map((c) => [c.dataset.type, c.dataset.id, c.textContent])).toEqual([
      ["kb", "kb-1", "支付排障手册"],
      ["kb_page", "page-1#b8Xz", "支付回调"],
      ["kb_mr", "mr-1", "#16 去重键…"],
      ["kb_annotation", "a-1", "批注 · 支付回调"],
    ]);
  });
});
