"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { cn } from "@marvis/ui/lib/utils";
import { useAuthStore } from "@marvis/core/auth";
import { useLocale } from "../i18n";
import { useDashboardCtaHref } from "../utils/use-dashboard-cta";

const CHANGELOG_PATH = "/changelog";

export function LandingHeader() {
  const { t } = useLocale();
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const ctaHref = useDashboardCtaHref();
  const ctaLabel = user ? t.header.dashboard : t.header.cta;
  const onChangelog = pathname === CHANGELOG_PATH;

  return (
    <header className="relative z-30">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <Link href="/" className="flex shrink-0 items-center gap-2.5">
          <MarvisIcon className="size-7 text-[#0f0f0f]" noSpin />
          <span className="text-[18px] font-semibold text-[#0f0f0f]">
            Marvis
          </span>
        </Link>

        <div className="flex items-center gap-2">
          <nav aria-label={t.header.navigation} className="hidden md:flex">
            <Link
              href={CHANGELOG_PATH}
              aria-current={onChangelog ? "page" : undefined}
              className={cn(
                "inline-flex h-10 items-center rounded-full px-4 text-[15px] transition-colors",
                onChangelog
                  ? "bg-white font-medium text-[#0f0f0f]"
                  : "text-[#444] hover:text-[#7b4835]",
              )}
            >
              {t.header.changelog}
            </Link>
          </nav>
          <Link
            href={ctaHref}
            className="inline-flex h-10 items-center rounded-full bg-[#0f0f0f] px-[18px] text-[14px] font-medium text-white transition-colors hover:bg-[#0f0f0f]/88"
          >
            {ctaLabel}
          </Link>
          <button
            type="button"
            aria-label={isMenuOpen ? t.header.closeMenu : t.header.openMenu}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen((open) => !open)}
            className={cn(
              "inline-flex size-10 items-center justify-center rounded-full md:hidden",
              isMenuOpen ? "bg-[#0f0f0f] text-white" : "bg-white text-[#0f0f0f]",
            )}
          >
            {isMenuOpen ? (
              <X className="size-[18px]" aria-hidden />
            ) : (
              <Menu className="size-[18px]" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {isMenuOpen ? (
        <div className="absolute inset-x-0 top-[76px] px-5 md:hidden">
          <nav
            aria-label={t.header.navigation}
            className="flex flex-col rounded-(--landing-radius-panel) bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_16px_40px_rgba(0,0,0,0.10)]"
          >
            <Link
              href={CHANGELOG_PATH}
              onClick={() => setIsMenuOpen(false)}
              className="flex h-12 items-center rounded-(--landing-radius-card) px-4 text-[16px] text-[#0f0f0f] hover:bg-[#f7f7f7]"
            >
              {t.header.changelog}
            </Link>
          </nav>
        </div>
      ) : null}
    </header>
  );
}
