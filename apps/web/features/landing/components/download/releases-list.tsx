"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@marvis/ui/lib/utils";
import { useLocale } from "../../i18n";
import type { ReleaseSummary } from "../../utils/github-release";
import { fullDateLabel } from "../changelog-page-client";
import { LandingHeader } from "../landing-header";
import { PlatformRows } from "./all-platforms";

export const RELEASES_PATH = "/download/releases";

/** Changelog entries and dates are keyed by bare semver; tags carry a `v`. */
export function releaseVersionLabel(tag: string) {
  return tag.startsWith("v") ? tag : `v${tag}`;
}

export function releaseDateLabel(
  publishedAt: string | null,
  locale: Parameters<typeof fullDateLabel>[1],
) {
  return publishedAt ? fullDateLabel(publishedAt.slice(0, 10), locale) : "";
}

export function ReleasesList({ releases }: { releases: ReleaseSummary[] }) {
  const { t, locale } = useLocale();
  const d = t.download.releases;
  // The newest release opens by default; it is what most visitors want.
  const [expanded, setExpanded] = useState<string | null>(
    releases[0]?.version ?? null,
  );

  return (
    <div className="min-h-full bg-[#f7f7f7] text-[#0f0f0f]">
      <LandingHeader />
      <main className="mx-auto flex max-w-[880px] flex-col gap-7 px-5 pb-24 pt-10 sm:px-8 sm:pt-12">
        <Link
          href="/download"
          className="self-start text-[14px] text-[#666] hover:text-[#7b4835]"
        >
          ‹ {d.back}
        </Link>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[30px] font-semibold sm:text-[40px]">{d.title}</h1>
          <p className="text-[#666]">{d.sub}</p>
        </div>

        {releases.length === 0 ? (
          <p className="text-[#888]">{d.empty}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {releases.map((release, i) => {
              const isOpen = expanded === release.version;
              const label = releaseVersionLabel(release.version);
              const toggle = () => setExpanded(isOpen ? null : release.version);
              return (
                <li
                  key={release.version}
                  className="overflow-hidden rounded-(--landing-radius-tile) bg-white"
                >
                  <div className="flex items-center gap-3 py-2 pl-5 pr-2">
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={isOpen}
                      className="flex min-h-[52px] min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-left"
                    >
                      <span className="text-[17px] font-semibold">{label}</span>
                      {i === 0 ? (
                        <span className="flex h-[22px] items-center rounded-full bg-[#0f0f0f] px-2 text-[12px] text-white">
                          {d.latest}
                        </span>
                      ) : null}
                      <span className="text-[13px] text-[#888]">
                        {releaseDateLabel(release.publishedAt, locale)}
                      </span>
                    </button>
                    <Link
                      href={`${RELEASES_PATH}/${encodeURIComponent(release.version)}`}
                      className="flex h-9 shrink-0 items-center rounded-full px-3.5 text-[13px] text-[#666] hover:text-[#7b4835]"
                    >
                      {d.notesLink} ›
                    </Link>
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? d.collapse : d.expand}
                      className="grid size-9 shrink-0 place-items-center rounded-full bg-[#f2f2f2] hover:bg-[#e8e8e8]"
                    >
                      <ChevronDown
                        className={cn("size-3.5 transition-transform", isOpen && "rotate-180")}
                        aria-hidden
                      />
                    </button>
                  </div>
                  {isOpen ? (
                    <div className="border-t border-black/6">
                      <PlatformRows assets={release.assets} hideMissing />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </div>
  );
}
