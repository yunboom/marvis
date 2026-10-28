import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { ArrowUpRight } from "lucide-react";

// Docs-local stateless Marvis mark — matches @marvis/ui's MarvisIcon
// visually (rounded square with a knocked-out "M"), but without hooks so it's
// safe to render from Server Components such as layout.config.tsx /
// layout.tsx. Keep in sync with
// packages/ui/components/common/marvis-icon.tsx if the mark changes.
function MarvisMark() {
  return (
    <svg viewBox="0 0 100 100" className="size-[1em]" aria-hidden="true">
      {/* One even-odd path cuts the "M" out of the square, so the mark needs
          no <mask> id that would collide between its several renders. */}
      <path
        fillRule="evenodd"
        fill="currentColor"
        d="M26 0h48a26 26 0 0 1 26 26v48a26 26 0 0 1-26 26H26A26 26 0 0 1 0 74V26A26 26 0 0 1 26 0ZM27 70V30h12l11 20 11-20h12v40H63V46l-9 16h-8l-9-16v24Z"
      />
    </svg>
  );
}

// External links shown at the top of the sidebar (and in the top nav on
// desktop). Leading icon = brand identity (Marvis mark);
// trailing ArrowUpRight = "opens externally" glyph, same pattern as
// `packages/views/layout/help-launcher.tsx` from PR #1560.
const externalLinkText = (label: string) => (
  <span className="inline-flex items-center gap-1">
    {label}
    <ArrowUpRight className="size-3 translate-y-px text-muted-foreground/60" />
  </span>
);

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <>
        <span className="text-[1.375rem]">
          <MarvisMark />
        </span>
        <span>Marvis Docs</span>
      </>
    ),
  },
  links: [
    {
      icon: <MarvisMark />,
      text: externalLinkText("Marvis"),
      url: "https://marvis.ai",
      external: true,
    },
  ],
};
