"use client";

import {
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@marvis/ui/lib/utils";
import { LandingHeader } from "./landing-header";
import { useLocale } from "../i18n";
import type { Locale } from "../i18n/types";

type ParsedDate = { year: number; month: number; day: number };

function parseDate(dateStr: string): ParsedDate {
  const parts = dateStr.split("-");
  return {
    year: Number(parts[0]),
    month: Number(parts[1]),
    day: Number(parts[2]),
  };
}

function utcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function monthYearLabel(year: number, month: number, locale: Locale) {
  const date = utcDate(year, month, 1);
  if (!date) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

export function fullDateLabel(dateStr: string, locale: Locale) {
  const { year, month, day } = parseDate(dateStr);
  const date = utcDate(year, month, day);
  if (!date) return dateStr;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

type Release = {
  version: string;
  date: string;
  title: string;
  changes: string[];
  features?: string[];
  improvements?: string[];
  fixes?: string[];
};

type MonthGroup = {
  key: string;
  year: number;
  month: number;
  entries: Release[];
};

function groupByMonth(entries: readonly Release[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  for (const entry of entries) {
    const { year, month } = parseDate(entry.date);
    const key = `${year}-${month}`;
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ key, year, month, entries: [entry] });
    }
  }
  return groups;
}

function anchorId(version: string) {
  return `release-${version.replace(/\./g, "-")}`;
}

function ChangeList({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((change) => (
        <li key={change} className="flex gap-2.5 text-[15px] text-[#444]">
          <span
            aria-hidden="true"
            className="mt-2.5 size-1 shrink-0 rounded-full bg-[#bbb]"
          />
          {change}
        </li>
      ))}
    </ul>
  );
}

export function ChangelogPageClient() {
  const { t, locale } = useLocale();
  const categoryLabels = t.changelog.categories;
  const entries = t.changelog.entries;
  const groups = useMemo(() => groupByMonth(entries), [entries]);

  const [activeVersion, setActiveVersion] = useState<string>(
    entries[0]?.version ?? ""
  );
  const navLockRef = useRef<number | null>(null);

  useEffect(() => {
    if (entries.length === 0) return;
    const visible = new Set<string>();

    const observer = new IntersectionObserver(
      (observed) => {
        observed.forEach((e) => {
          const v = (e.target as HTMLElement).dataset.version;
          if (!v) return;
          if (e.isIntersecting) visible.add(v);
          else visible.delete(v);
        });
        // Ignore observer updates while we're programmatically scrolling
        // to a clicked target — otherwise the active indicator flickers
        // through each passing entry.
        if (navLockRef.current !== null) return;

        const firstVisible = entries.find((r) => visible.has(r.version));
        if (firstVisible) {
          setActiveVersion(firstVisible.version);
          return;
        }
        const scrollY = window.scrollY;
        let best = entries[0]?.version ?? "";
        for (const r of entries) {
          const el = document.getElementById(anchorId(r.version));
          if (!el) continue;
          if (el.getBoundingClientRect().top + scrollY <= scrollY + 160) {
            best = r.version;
          }
        }
        setActiveVersion(best);
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
    );

    entries.forEach((r) => {
      const el = document.getElementById(anchorId(r.version));
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, [entries]);

  const jumpTo =
    (version: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      const el = document.getElementById(anchorId(version));
      if (!el) return;
      e.preventDefault();
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      window.history.replaceState(null, "", `#${anchorId(version)}`);
      setActiveVersion(version);
      if (navLockRef.current !== null) {
        window.clearTimeout(navLockRef.current);
      }
      navLockRef.current = window.setTimeout(() => {
        navLockRef.current = null;
      }, 800);
    };

  return (
    <div className="min-h-full bg-[#f7f7f7] text-[#0f0f0f]">
      <LandingHeader />
      <main className="mx-auto flex max-w-[1080px] gap-14 px-5 pb-24 pt-10 sm:px-8 sm:pt-16">
        <aside className="hidden w-[180px] shrink-0 lg:block">
          <nav
            aria-label={t.changelog.toc}
            className="sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col gap-5 overflow-y-auto pb-8"
          >
            {groups.map((group) => (
              <div key={group.key} className="flex flex-col gap-1">
                <p className="mb-1 px-3 text-[12px] text-[#888]">
                  {monthYearLabel(group.year, group.month, locale)}
                </p>
                {group.entries.map((release) => {
                  const isActive = release.version === activeVersion;
                  return (
                    <a
                      key={release.version}
                      href={`#${anchorId(release.version)}`}
                      onClick={jumpTo(release.version)}
                      aria-current={isActive ? "true" : undefined}
                      className={cn(
                        "flex h-8 items-center rounded-(--landing-radius-control) px-3 text-[14px] tabular-nums transition-colors",
                        isActive
                          ? "bg-white font-semibold text-[#0f0f0f]"
                          : "text-[#666] hover:text-[#7b4835]",
                      )}
                    >
                      v{release.version}
                    </a>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-10">
          <div className="flex flex-col gap-2">
            <h1 className="text-[30px] font-semibold sm:text-[44px]">
              {t.changelog.title}
            </h1>
            <p className="text-[#666]">{t.changelog.subtitle}</p>
          </div>

          {entries.map((release) => {
            const categorized = [
              { label: categoryLabels.features, items: release.features },
              { label: categoryLabels.improvements, items: release.improvements },
              { label: categoryLabels.fixes, items: release.fixes },
            ].filter((g) => g.items && g.items.length > 0);
            return (
              <article
                key={release.version}
                id={anchorId(release.version)}
                data-version={release.version}
                className="flex scroll-mt-6 flex-col gap-[18px] rounded-(--landing-radius-panel) bg-white p-[22px] sm:p-7"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <span className="flex h-[26px] items-center rounded-full bg-[#0f0f0f] px-2.5 text-[13px] font-medium tabular-nums text-white">
                    v{release.version}
                  </span>
                  <span className="text-[13px] text-[#888]">
                    {fullDateLabel(release.date, locale)}
                  </span>
                </div>
                <h2 className="text-balance text-[22px] font-semibold leading-[1.4]">
                  {release.title}
                </h2>

                {categorized.length > 0 ? (
                  categorized.map((group) => (
                    <div key={group.label} className="flex flex-col gap-2">
                      <h3 className="text-[13px] font-semibold text-[#7b4835]">
                        {group.label}
                      </h3>
                      <ChangeList items={group.items ?? []} />
                    </div>
                  ))
                ) : (
                  <ChangeList items={release.changes} />
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}
