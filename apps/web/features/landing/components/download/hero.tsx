import Link from "next/link";
import { Download } from "lucide-react";
import { useLocale } from "../../i18n";
import type { DetectResult } from "../../utils/os-detect";
import type { DownloadAssets } from "../../utils/parse-release-assets";
import { MacHintTrigger } from "./mac-hint";

interface Props {
  detected: DetectResult | null;
  assets: DownloadAssets;
  /** True when the GitHub API fetch failed; disables all CTAs and
   *  surfaces a "version unavailable" line. */
  versionUnavailable: boolean;
}

/**
 * Top CTA section. Server-renders a generic "Choose your platform"
 * placeholder (SEO + flash-before-hydration), then swaps to a
 * platform-specific CTA once the client detection resolves.
 */
export function DownloadHero({
  detected,
  assets,
  versionUnavailable,
}: Props) {
  const { t } = useLocale();
  const d = t.download.hero;

  const content = resolveContent(detected, assets, versionUnavailable, d);

  return (
    <section className="mx-auto flex max-w-[1200px] flex-col items-center gap-5 px-5 pb-14 pt-12 text-center sm:px-8 sm:pt-[72px]">
      <h1 className="text-[34px] font-semibold tracking-[-0.01em] sm:text-[52px]">
        {content.title}
      </h1>
      <p className="text-[#666]">{content.sub}</p>

      {content.primary || content.alt ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          {content.primary ? (
            <PrimaryCta
              href={content.primary.href}
              disabled={content.primary.disabled}
            >
              <Download className="size-4" aria-hidden />
              {content.primary.label}
            </PrimaryCta>
          ) : null}
          {content.alt ? (
            <Link
              href={content.alt.href}
              className="inline-flex h-12 items-center rounded-full border border-black/8 bg-white px-[22px] text-[#0f0f0f] transition-colors hover:text-[#7b4835]"
            >
              {content.alt.label}
            </Link>
          ) : null}
        </div>
      ) : null}

      {detected?.os === "mac" ? <MacHintTrigger size="lg" /> : null}

      {content.hint ? (
        <p className="text-[13px] text-[#888]">{content.hint}</p>
      ) : null}

      {versionUnavailable ? (
        <p className="text-[13px] text-[#888]">
          {t.download.footer.versionUnavailable}
        </p>
      ) : null}
    </section>
  );
}

// Content resolver — maps (detect, assets) → CTA props

interface HeroContent {
  title: string;
  sub: string;
  primary?: {
    href: string;
    label: string;
    disabled: boolean;
  };
  alt?: { href: string; label: string };
  hint?: string;
}

type HeroDict = ReturnType<typeof useLocale>["t"]["download"]["hero"];

export function resolveContent(
  detected: DetectResult | null,
  assets: DownloadAssets,
  versionUnavailable: boolean,
  d: HeroDict,
): HeroContent {
  // Before hydration resolves, render a neutral prompt. Same copy
  // also catches `os === "unknown"`.
  if (!detected || detected.os === "unknown") {
    return { title: d.unknown.title, sub: d.unknown.sub };
  }

  if (detected.os === "mac") {
    // Only Chromium high-entropy returns arch confidently. Safari
    // always reports Intel even on Apple Silicon, so we treat
    // "non-confident" as arm64 + point Intel users to the matrix below.
    if (detected.arch === "x64" && detected.archConfident) {
      const dmg = assets.macX64Dmg;
      const zip = assets.macX64Zip;
      return {
        title: d.macIntel.title,
        sub: d.macIntel.sub,
        primary: dmg
          ? {
              href: dmg,
              label: d.macIntel.primary,
              disabled: false,
            }
          : versionUnavailable
            ? { href: "#", label: d.macIntel.primary, disabled: true }
            : undefined,
        alt: zip
          ? {
              href: zip,
              label: d.macIntel.altZip,
            }
          : undefined,
      };
    }
    const dmg = assets.macArm64Dmg;
    const zip = assets.macArm64Zip;
    return {
      title: d.macArm64.title,
      sub: d.macArm64.sub,
      primary: dmg
        ? {
            href: dmg,
            label: d.macArm64.primary,
            disabled: false,
          }
        : versionUnavailable
          ? { href: "#", label: d.macArm64.primary, disabled: true }
          : undefined,
      alt: zip
        ? {
            href: zip,
            label: d.macArm64.altZip,
          }
        : undefined,
      hint: detected.archConfident ? undefined : d.safariMacHint,
    };
  }

  if (detected.os === "windows") {
    // Trust arch whenever the UA hints at it (even non-confident);
    // Windows-on-ARM can still run x64 via emulation so this is low
    // risk either way. Surface the arch-fallback hint when we're
    // guessing so users on uncommon setups know to scroll down.
    const isArm = detected.arch === "arm64";
    const copy = isArm ? d.winArm64 : d.winX64;
    const url = isArm ? assets.winArm64Exe : assets.winX64Exe;
    return {
      title: copy.title,
      sub: copy.sub,
      primary: url
        ? {
            href: url,
            label: copy.primary,
            disabled: false,
          }
        : versionUnavailable
          ? { href: "#", label: copy.primary, disabled: true }
          : undefined,
      hint: detected.archConfident ? undefined : d.archFallbackHint,
    };
  }

  // Linux — same principle: trust the arm64 signal, surface a hint
  // when we're not confident. Linux ARM has no binary emulation so
  // the hint matters more here than on Windows.
  const isArmLinux = detected.arch === "arm64";
  const primaryUrl = isArmLinux
    ? assets.linuxArm64AppImage
    : assets.linuxAmd64AppImage;
  return {
    title: d.linux.title,
    sub: d.linux.sub,
    primary: primaryUrl
      ? {
          href: primaryUrl,
          label: d.linux.primary,
          disabled: false,
        }
      : versionUnavailable
        ? { href: "#", label: d.linux.primary, disabled: true }
        : undefined,
    alt: { href: "#all-platforms", label: d.linux.altFormats },
    hint: detected.archConfident ? undefined : d.archFallbackHint,
  };
}

// Pieces

function PrimaryCta({
  href,
  disabled,
  children,
}: {
  href: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-12 cursor-not-allowed items-center gap-2 rounded-full bg-[#f2f2f2] px-7 font-medium text-[#9a9a9a]"
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      className="inline-flex h-12 items-center gap-2 rounded-full bg-[#0f0f0f] px-7 font-medium text-white transition-colors hover:bg-[#0f0f0f]/88"
    >
      {children}
    </a>
  );
}
