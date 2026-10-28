"use client";

import Image from "next/image";
import Link from "next/link";
import { Download } from "lucide-react";
import { useAuthStore } from "@marvis/core/auth";
import { BASE_PATH } from "@/config/base-path";
import { useLocale } from "../i18n";
import { useDashboardCtaHref } from "../utils/use-dashboard-cta";

export function LandingHero() {
  const { t } = useLocale();
  const user = useAuthStore((s) => s.user);
  const ctaHref = useDashboardCtaHref();

  return (
    <section
      id="product"
      className="mx-auto flex max-w-[1200px] flex-col items-center gap-6 px-5 pb-10 pt-12 text-center sm:px-8 sm:pb-[72px] sm:pt-24"
    >
      <h1 className="text-balance text-[34px] font-semibold leading-[1.2] tracking-[-0.01em] sm:text-[48px] lg:text-[64px]">
        {t.hero.headlineLine1}
        <br />
        {t.hero.headlineLine2}
      </h1>
      <p className="text-[18px] text-[#666]">{t.hero.subheading}</p>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
        <Link
          href={ctaHref}
          className="inline-flex h-12 items-center rounded-full bg-[#0f0f0f] px-7 font-medium text-white transition-colors hover:bg-[#0f0f0f]/88"
        >
          {user ? t.header.dashboard : t.header.cta}
        </Link>
        <Link
          href="/download"
          className="inline-flex h-12 items-center gap-2 rounded-full border border-black/8 bg-white px-6 font-medium text-[#0f0f0f] transition-colors hover:text-[#7b4835]"
        >
          <Download className="size-4" aria-hidden />
          {t.hero.downloadDesktop}
        </Link>
      </div>

      <div className="mt-4 w-full max-w-[1136px] overflow-hidden rounded-(--landing-radius-panel) border border-white bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_24px_64px_rgba(0,0,0,0.08)]">
        <Image
          // next/image does not prefix a string src with basePath, and the
          // optimizer then fetches the unprefixed path and gets a 404.
          src={`${BASE_PATH}/images/landing-hero.webp`}
          alt={t.hero.imageAlt}
          width={2640}
          height={1780}
          preload
          className="block h-auto w-full"
          sizes="(max-width: 1200px) 100vw, 1136px"
          quality={85}
        />
      </div>
    </section>
  );
}
