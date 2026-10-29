"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LandingHeader } from "@/features/landing/components/landing-header";
import { DownloadHero } from "@/features/landing/components/download/hero";
import { AllPlatforms } from "@/features/landing/components/download/all-platforms";
import { CliSection } from "@/features/landing/components/download/cli-section";
import { useLocale } from "@/features/landing/i18n";
import {
  detectOS,
  type DetectResult,
} from "@/features/landing/utils/os-detect";
import type { LatestRelease } from "@/features/landing/utils/github-release";

const ALL_RELEASES_PATH = "/download/releases";

export function DownloadClient({ release }: { release: LatestRelease }) {
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const versionUnavailable = release.version === null;

  useEffect(() => {
    let cancelled = false;
    detectOS().then((result) => {
      if (cancelled) return;
      setDetected(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-full bg-[#f7f7f7] text-[#0f0f0f]">
      <LandingHeader />
      <main>
        <DownloadHero
          detected={detected}
          assets={release.assets}
          versionUnavailable={versionUnavailable}
        />
        <AllPlatforms assets={release.assets} />
        <CliSection />
        <VersionInfo version={release.version} />
      </main>
    </div>
  );
}

const versionLinkClassName = "text-[#666] hover:text-[#7b4835]";

function VersionInfo({ version }: { version: string | null }) {
  const { t } = useLocale();
  const d = t.download.footer;

  return (
    <section className="mx-auto flex max-w-[880px] flex-wrap gap-x-5 gap-y-3 px-5 pb-[72px] text-[13px] text-[#888] sm:px-8">
      {version ? (
        <>
          <span>{d.currentVersion.replace("{version}", version)}</span>
          <Link
            href={`${ALL_RELEASES_PATH}/${encodeURIComponent(version)}`}
            className={versionLinkClassName}
          >
            {d.releaseNotes.replace("{version}", version)}
          </Link>
        </>
      ) : (
        <span>{d.versionUnavailable}</span>
      )}
      <Link href={ALL_RELEASES_PATH} className={versionLinkClassName}>
        {d.allReleases}
      </Link>
    </section>
  );
}
