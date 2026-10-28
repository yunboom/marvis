import Link from "next/link";
import type { ReactNode } from "react";

/**
 * DocsHero — showpiece header for landing-style pages.
 *
 * Escapes prose scope to run its own type scale. Title accepts ReactNode so
 * callers can pass <em> spans for brand-color emphasis (italic is avoided —
 * Chinese italic is a synthetic slant and reads as broken).
 */
export function DocsHero({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
}) {
  return (
    <section className="not-prose mb-7 pt-2">
      {eyebrow ? (
        <p className="mb-3.5 text-caption font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <h1
        className={`${subtitle ? "mb-4" : "mb-0"} text-[1.875rem] font-semibold leading-[1.35] tracking-[-0.015em] text-foreground sm:text-[2.125rem]`}
      >
        {title}
      </h1>
      {subtitle ? (
        <p className="max-w-[36rem] text-[1rem] leading-[1.7] text-muted-foreground">
          {subtitle}
        </p>
      ) : null}
    </section>
  );
}

/**
 * DocsFeatureGrid / DocsFeatureCard — kept for back-compat with any pages
 * still using the old card grid before the editorial migration. Prefer
 * <NumberedCards>/<NumberedCard> from editorial.tsx for showpiece pages.
 */
export function DocsFeatureGrid({ children }: { children: ReactNode }) {
  return (
    <div className="not-prose my-8 grid grid-cols-1 gap-3 md:grid-cols-3">
      {children}
    </div>
  );
}

export function DocsFeatureCard({
  icon,
  title,
  description,
  href,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-[14px] bg-card p-5 no-underline shadow-[0_0_0_1px_var(--surface-border)] transition-colors hover:bg-[var(--surface-hover)]"
    >
      <div className="flex size-9 items-center justify-center text-foreground [&_svg]:size-[20px]">
        {icon}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.9375rem] font-medium text-foreground">
          {title}
        </span>
        <p className="text-sm leading-[1.55] text-muted-foreground">
          {description}
        </p>
      </div>
    </Link>
  );
}
