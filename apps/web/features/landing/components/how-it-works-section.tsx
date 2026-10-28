"use client";

import Link from "next/link";
import { useAuthStore } from "@marvis/core/auth";
import { docsHrefForLocale, useLocale } from "../i18n";
import { useDashboardCtaHref } from "../utils/use-dashboard-cta";
import { GitHubMark, githubUrl } from "./shared";

// The docs and GitHub links are hidden for now but kept, so turning them back
// on is a one-line change.
const SHOW_SECONDARY_LINKS = false;

const secondaryLinkClassName =
  "inline-flex h-11 items-center gap-2 rounded-full border border-white/24 px-6 text-white transition-colors hover:bg-white/8";

export function HowItWorksSection() {
  const { t, locale } = useLocale();
  const user = useAuthStore((s) => s.user);
  const ctaHref = useDashboardCtaHref();

  return (
    <section id="how-it-works" className="bg-[#0f0f0f] text-white">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-5 py-14 sm:px-8 sm:py-24">
        <h2 className="text-balance text-[26px] font-semibold sm:text-[40px]">
          {t.howItWorks.headline}
        </h2>

        <ol className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
          {t.howItWorks.steps.map((step, i) => (
            <li
              key={step.title}
              className="flex flex-col gap-2.5 rounded-(--landing-radius-panel) bg-[#1c1c1c] p-6"
            >
              <span className="text-[13px] tabular-nums text-[#c9a593]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="text-[18px] font-semibold">{step.title}</h3>
              <p className="text-[14px] text-[#b3b3b3]">{step.description}</p>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-3">
          <Link
            href={ctaHref}
            className="inline-flex h-11 items-center rounded-full bg-white px-6 font-medium text-[#0f0f0f] transition-colors hover:bg-white/90"
          >
            {user ? t.header.dashboard : t.howItWorks.cta}
          </Link>
          {SHOW_SECONDARY_LINKS ? (
            <>
              <Link
                href={docsHrefForLocale(locale)}
                className={secondaryLinkClassName}
              >
                {t.howItWorks.ctaDocs}
              </Link>
              <Link
                href={githubUrl}
                target="_blank"
                rel="noreferrer"
                className={secondaryLinkClassName}
              >
                <GitHubMark className="size-4" />
                {t.howItWorks.ctaGithub}
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
