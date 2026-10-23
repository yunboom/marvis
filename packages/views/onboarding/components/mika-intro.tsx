"use client";

import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@marvis/ui/components/ui/item";
import { useT } from "../../i18n";
import mikaAvatar from "./mika-avatar.svg";
import { StepHeading } from "./step-shell";

/** Mirrors server/internal/handler/mika_avatar.svg, the artwork stored on the
 *  created agent — these two must move together or onboarding shows one face
 *  and the created agent another. Next.js exposes static imports as objects
 *  while Vite exposes URL strings. */
export const MIKA_AVATAR_SRC =
  typeof mikaAvatar === "string" ? mikaAvatar : mikaAvatar.src;

/**
 * The subject of step 3, stated as an object rather than a footnote.
 *
 * The step used to be titled after its dependency — "Pick an agent runtime" —
 * with Mika named only in the grey lede. That put the thing being created in
 * the small print and the technical prerequisite in the headline, so a member
 * reached a button saying "Start with Mika" without ever being told who that
 * is. Headline plus a card with a mark on it is what makes the introduction
 * survive not reading carefully.
 *
 * Mika does not exist yet at this point in the flow — she is created when the
 * member commits — so this cannot render her stored avatar. It reuses the mark
 * the Runtimes page already uses for "Start with Mika" instead, which keeps
 * the two entry points recognisably the same thing.
 */
export function MikaIntro() {
  const { t } = useT("onboarding");
  return (
    <div className="flex flex-col gap-5">
      <StepHeading title={t(($) => $.mika_intro.headline)} />
      <Item variant="outline" className="items-start gap-3.5 rounded-xl border-surface-border p-4">
        <ItemMedia>
          <img
            src={MIKA_AVATAR_SRC}
            alt={t(($) => $.mika_intro.name)}
            className="size-9 shrink-0 select-none rounded-full object-cover"
          />
        </ItemMedia>
        <ItemContent>
          <ItemTitle className="gap-0 text-body-lg">
            {t(($) => $.mika_intro.name)}
            <span className="whitespace-pre font-normal text-muted-foreground">
              {" · "}
              {t(($) => $.mika_intro.role)}
            </span>
          </ItemTitle>
          <ItemDescription className="mt-0.5 text-label leading-relaxed">
            {t(($) => $.mika_intro.blurb)}
          </ItemDescription>
        </ItemContent>
      </Item>
    </div>
  );
}
