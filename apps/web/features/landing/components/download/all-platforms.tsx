import Link from "next/link";
import { useLocale } from "../../i18n";
import type { AssetVersions } from "../../utils/github-release";
import type { DownloadAssets } from "../../utils/parse-release-assets";
import { MacHintTrigger } from "./mac-hint";

const ALL_RELEASES_PATH = "/download/releases";

/**
 * Full matrix of platform + arch + format links. Always visible
 * regardless of which platform the Hero resolved to — lets power
 * users grab any build directly.
 */
export function AllPlatforms({
  assets,
  assetVersions,
  latestVersion,
}: {
  assets: DownloadAssets;
  assetVersions?: AssetVersions;
  latestVersion?: string | null;
}) {
  const { t } = useLocale();
  const d = t.download.allPlatforms;

  return (
    <section
      id="all-platforms"
      className="mx-auto flex max-w-[880px] flex-col gap-5 px-5 pb-16 sm:px-8"
    >
      <h2 className="text-[24px] font-semibold sm:text-[28px]">{d.title}</h2>
      <div className="overflow-hidden rounded-(--landing-radius-panel) bg-white">
        <PlatformRows
          assets={assets}
          assetVersions={assetVersions}
          latestVersion={latestVersion}
        />
      </div>
      <Link
        href={ALL_RELEASES_PATH}
        className="self-start text-[13px] text-[#666] hover:text-[#7b4835]"
      >
        {t.download.footer.allReleases} →
      </Link>
    </section>
  );
}

/**
 * One row per platform/arch with its installer formats. The download page
 * shows a missing format as disabled so the matrix keeps its shape; the
 * release pages pass `hideMissing` and list only what that release shipped.
 *
 * When `assetVersions` says a download comes from an older release than
 * `latestVersion`, that version is shown next to the row, or next to the
 * format when the row's formats come from different releases.
 */
export function PlatformRows({
  assets,
  assetVersions = {},
  latestVersion,
  hideMissing = false,
}: {
  assets: DownloadAssets;
  assetVersions?: AssetVersions;
  latestVersion?: string | null;
  hideMissing?: boolean;
}) {
  const { t } = useLocale();
  const d = t.download.allPlatforms;

  const format = (label: string, key: keyof DownloadAssets): FormatProps => {
    const version = assetVersions[key];
    return {
      label,
      href: assets[key],
      olderVersion: version && version !== latestVersion ? version : undefined,
    };
  };

  const rows: RowProps[] = [
    {
      label: d.macArm64Label,
      mac: true,
      formats: [
        format(d.formatDmg, "macArm64Dmg"),
        format(d.formatZip, "macArm64Zip"),
      ],
    },
    {
      label: d.macX64Label,
      mac: true,
      formats: [
        format(d.formatDmg, "macX64Dmg"),
        format(d.formatZip, "macX64Zip"),
      ],
    },
    {
      label: d.winX64Label,
      formats: [format(d.formatExe, "winX64Exe")],
    },
    {
      label: d.winArm64Label,
      formats: [format(d.formatExe, "winArm64Exe")],
    },
    {
      label: d.linuxX64Label,
      formats: [
        format(d.formatAppImage, "linuxAmd64AppImage"),
        format(d.formatDeb, "linuxAmd64Deb"),
        format(d.formatRpm, "linuxAmd64Rpm"),
      ],
    },
    {
      label: d.linuxArm64Label,
      formats: [
        format(d.formatAppImage, "linuxArm64AppImage"),
        format(d.formatDeb, "linuxArm64Deb"),
        format(d.formatRpm, "linuxArm64Rpm"),
      ],
    },
  ];

  const visible = hideMissing
    ? rows
        .map((row) => ({ ...row, formats: row.formats.filter((f) => f.href) }))
        .filter((row) => row.formats.length > 0)
    : rows;

  return (
    <>
      {visible.map((row) => (
        <Row key={row.label} {...row} unavailable={d.unavailable} />
      ))}
    </>
  );
}

interface FormatProps {
  label: string;
  href: string | undefined;
  /** Set when the download comes from a release older than the latest. */
  olderVersion?: string;
}

interface RowProps {
  label: string;
  mac?: boolean;
  formats: FormatProps[];
  unavailable?: string;
}

function Row({ label, mac, formats, unavailable }: RowProps) {
  const offered = formats.filter((f) => f.href);
  const firstVersion = offered[0]?.olderVersion;
  // One older version for the whole row reads best beside the label; mixed
  // sources fall back to marking each format.
  const rowVersion =
    firstVersion && offered.every((f) => f.olderVersion === firstVersion)
      ? firstVersion
      : undefined;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/6 px-6 py-[18px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-medium">{label}</span>
        {rowVersion ? <ReleaseVersionLink version={rowVersion} /> : null}
        {mac ? <MacHintTrigger /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {formats.map((f) =>
          f.href ? (
            <span key={f.label} className="inline-flex items-center gap-1.5">
              <a
                href={f.href}
                className="inline-flex h-[34px] items-center rounded-full border border-black/12 px-3.5 text-[13px] transition-colors hover:border-black/30 hover:text-[#7b4835]"
              >
                {f.label}
              </a>
              {!rowVersion && f.olderVersion ? (
                <ReleaseVersionLink version={f.olderVersion} />
              ) : null}
            </span>
          ) : (
            <span
              key={f.label}
              aria-disabled="true"
              title={unavailable}
              className="inline-flex h-[34px] cursor-not-allowed items-center rounded-full bg-[#f2f2f2] px-3.5 text-[13px] text-[#9a9a9a]"
            >
              {f.label}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function ReleaseVersionLink({ version }: { version: string }) {
  return (
    <Link
      href={`${ALL_RELEASES_PATH}/${encodeURIComponent(version)}`}
      className="text-[13px] text-[#888] hover:text-[#7b4835]"
    >
      {version}
    </Link>
  );
}
