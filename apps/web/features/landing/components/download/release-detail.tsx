"use client";

import Link from "next/link";
import { useLocale } from "../../i18n";
import type { ReleaseSummary } from "../../utils/github-release";
import { LandingHeader } from "../landing-header";
import { PlatformRows } from "./all-platforms";
import {
  RELEASES_PATH,
  releaseDateLabel,
  releaseVersionLabel,
} from "./releases-list";

export function ReleaseDetail({
  release,
  isLatest,
}: {
  release: ReleaseSummary;
  isLatest: boolean;
}) {
  const { t, locale } = useLocale();
  const d = t.download.releaseDetail;
  const bare = release.version.replace(/^v/, "");
  const entry = t.changelog.entries.find((e) => e.version === bare);
  const notes = entry
    ? [
        ...entry.changes,
        ...(entry.features ?? []),
        ...(entry.improvements ?? []),
        ...(entry.fixes ?? []),
      ]
    : [d.notesFallback];
  const changelogHref = entry
    ? `/changelog#release-${bare.replace(/\./g, "-")}`
    : "/changelog";

  return (
    <div className="min-h-full bg-[#f7f7f7] text-[#0f0f0f]">
      <LandingHeader />
      <main className="mx-auto flex max-w-[880px] flex-col gap-7 px-5 pb-24 pt-10 sm:px-8 sm:pt-12">
        <Link
          href={RELEASES_PATH}
          className="self-start text-[14px] text-[#666] hover:text-[#7b4835]"
        >
          ‹ {d.back}
        </Link>
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-[30px] font-semibold sm:text-[40px]">
              {releaseVersionLabel(release.version)}
            </h1>
            {isLatest ? (
              <span className="flex h-6 items-center rounded-full bg-[#0f0f0f] px-2.5 text-[12px] text-white">
                {t.download.releases.latest}
              </span>
            ) : null}
          </div>
          <span className="text-[14px] text-[#888]">
            {releaseDateLabel(release.publishedAt, locale)}
          </span>
        </div>

        <section className="flex flex-col gap-3.5 rounded-(--landing-radius-panel) bg-white p-[22px] sm:p-7">
          <h2 className="text-[18px] font-semibold">{d.notesTitle}</h2>
          <ul className="flex flex-col gap-2">
            {notes.map((note) => (
              <li key={note} className="flex gap-2.5 text-[15px] text-[#444]">
                <span
                  aria-hidden
                  className="mt-2.5 size-1 shrink-0 rounded-full bg-[#bbb]"
                />
                {note}
              </li>
            ))}
          </ul>
          <Link
            href={changelogHref}
            className="self-start text-[13px] text-[#666] hover:text-[#7b4835]"
          >
            {d.viewChangelog} →
          </Link>
        </section>

        <section className="flex flex-col gap-3.5">
          <h2 className="text-[18px] font-semibold">{d.downloadsTitle}</h2>
          <div className="overflow-hidden rounded-(--landing-radius-panel) bg-white">
            <PlatformRows assets={release.assets} hideMissing />
          </div>
          <p className="text-[13px] text-[#888]">
            {d.cliHintPrefix}
            <Link href="/download" className="text-[#666] hover:text-[#7b4835]">
              {d.cliHintLink}
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}
