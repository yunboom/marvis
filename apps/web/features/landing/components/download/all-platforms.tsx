import Link from "next/link";
import { useLocale } from "../../i18n";
import type { DownloadAssets } from "../../utils/parse-release-assets";
import { MacHintTrigger } from "./mac-hint";

interface Props {
  assets: DownloadAssets;
  /** Where "view all releases" points; also the escape hatch when some
   *  asset URLs couldn't be resolved (API down / parse failure). */
  fallbackHref: string;
}

/**
 * Full matrix of platform + arch + format links. Always visible
 * regardless of which platform the Hero resolved to — lets power
 * users grab any build directly.
 */
export function AllPlatforms({ assets, fallbackHref }: Props) {
  const { t } = useLocale();
  const d = t.download.allPlatforms;

  const rows: RowProps[] = [
    {
      label: d.macArm64Label,
      mac: true,
      formats: [
        { label: d.formatDmg, href: assets.macArm64Dmg },
        { label: d.formatZip, href: assets.macArm64Zip },
      ],
    },
    {
      label: d.macX64Label,
      mac: true,
      formats: [
        { label: d.formatDmg, href: assets.macX64Dmg },
        { label: d.formatZip, href: assets.macX64Zip },
      ],
    },
    {
      label: d.winX64Label,
      formats: [{ label: d.formatExe, href: assets.winX64Exe }],
    },
    {
      label: d.winArm64Label,
      formats: [{ label: d.formatExe, href: assets.winArm64Exe }],
    },
    {
      label: d.linuxX64Label,
      formats: [
        { label: d.formatAppImage, href: assets.linuxAmd64AppImage },
        { label: d.formatDeb, href: assets.linuxAmd64Deb },
        { label: d.formatRpm, href: assets.linuxAmd64Rpm },
      ],
    },
    {
      label: d.linuxArm64Label,
      formats: [
        { label: d.formatAppImage, href: assets.linuxArm64AppImage },
        { label: d.formatDeb, href: assets.linuxArm64Deb },
        { label: d.formatRpm, href: assets.linuxArm64Rpm },
      ],
    },
  ];

  return (
    <section
      id="all-platforms"
      className="mx-auto flex max-w-[880px] flex-col gap-5 px-5 pb-16 sm:px-8"
    >
      <h2 className="text-[24px] font-semibold sm:text-[28px]">{d.title}</h2>
      <div className="overflow-hidden rounded-(--landing-radius-panel) bg-white">
        {rows.map((row) => (
          <Row key={row.label} {...row} unavailable={d.unavailable} />
        ))}
      </div>
      <Link
        href={fallbackHref}
        target="_blank"
        rel="noreferrer"
        className="self-start text-[13px] text-[#666] hover:text-[#7b4835]"
      >
        {t.download.footer.allReleases} →
      </Link>
    </section>
  );
}

interface RowProps {
  label: string;
  mac?: boolean;
  formats: { label: string; href: string | undefined }[];
  unavailable?: string;
}

function Row({ label, mac, formats, unavailable }: RowProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/6 px-6 py-[18px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="font-medium">{label}</span>
        {mac ? <MacHintTrigger /> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {formats.map((f) =>
          f.href ? (
            <a
              key={f.label}
              href={f.href}
              className="inline-flex h-[34px] items-center rounded-full border border-black/12 px-3.5 text-[13px] transition-colors hover:border-black/30 hover:text-[#7b4835]"
            >
              {f.label}
            </a>
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
