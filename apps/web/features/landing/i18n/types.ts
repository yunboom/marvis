import type { SupportedLocale } from "@marvis/core/i18n";
export { docsHrefForLocale } from "@/lib/docs-href";

export type Locale = SupportedLocale;
export type LandingDictionaryLocale = "en" | "zh" | "ko" | "ja";

export const locales: Locale[] = ["en", "zh-Hans", "ko", "ja"];

export const localeLabels: Record<Locale, string> = {
  en: "EN",
  "zh-Hans": "\u4e2d\u6587",
  // The landing dictionary has no Traditional Chinese variant yet, so
  // `locales` above does not offer it and it reads the Simplified copy.
  "zh-Hant": "\u7e41\u9ad4\u4e2d\u6587",
  ko: "\ud55c\uad6d\uc5b4",
  ja: "\u65e5\u672c\u8a9e",
  // The landing dictionary has no French variant yet, so `locales` above still
  // offers four languages; this label only satisfies the Record type.
  fr: "FR",
};

export function toLandingDictionaryLocale(
  locale: Locale,
): LandingDictionaryLocale {
  if (locale === "ko") return "ko";
  if (locale === "ja") return "ja";
  return isZhLocale(locale) ? "zh" : "en";
}

export function isZhLocale(locale: Locale): boolean {
  return locale === "zh-Hans" || locale === "zh-Hant";
}

// Long-form page copy. Paragraphs and bullets may embed `[label](href)`
// links, rendered by InlineLinks.
export type DocumentSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

type FooterGroup = {
  label: string;
  links: { label: string; href: string }[];
};

export type ContactSalesOption = { value: string; label: string };

export type LandingDict = {
  header: {
    cta: string;
    dashboard: string;
    changelog: string;
    navigation: string;
    openMenu: string;
    closeMenu: string;
  };
  hero: {
    headlineLine1: string;
    headlineLine2: string;
    subheading: string;
    cta: string;
    downloadDesktop: string;
    worksWith: string;
    imageAlt: string;
  };
  howItWorks: {
    headline: string;
    steps:{ title: string; description: string }[];
    cta: string;
    ctaGithub: string;
    ctaDocs: string;
  };
  footer: {
    tagline: string;
    cta: string;
    groups: {
      product: FooterGroup;
      resources: FooterGroup;
      company: FooterGroup;
    };
    copyright: string;
  };
  licensing: {
    title: string;
    intro: string[];
    rule: { title: string; text: string };
    scenarios: {
      title: string;
      scenarioColumn: string;
      licenseColumn: string;
      required: string;
      notRequired: string;
      items: { scenario: string; example?: string; required: boolean }[];
    };
    sections: DocumentSection[];
  };
  changelog: {
    title: string;
    subtitle: string;
    toc: string;
    categories: {
      features: string;
      improvements: string;
      fixes: string;
    };
    entries: {
      version: string;
      date: string;
      title: string;
      changes: string[];
      features?: string[];
      improvements?: string[];
      fixes?: string[];
    }[];
  };
  download: {
    hero: {
      macArm64: {
        title: string;
        sub: string;
        primary: string;
        altZip: string;
      };
      macIntel: {
        title: string;
        sub: string;
        primary: string;
        altZip: string;
      };
      winX64: { title: string; sub: string; primary: string };
      winArm64: { title: string; sub: string; primary: string };
      linux: {
        title: string;
        sub: string;
        primary: string;
        altFormats: string;
      };
      unknown: { title: string; sub: string };
      safariMacHint: string;
      archFallbackHint: string;
    };
    releases: {
      back: string;
      title: string;
      sub: string;
      latest: string;
      notesLink: string;
      expand: string;
      collapse: string;
      empty: string;
    };
    releaseDetail: {
      back: string;
      notesTitle: string;
      notesFallback: string;
      viewChangelog: string;
      downloadsTitle: string;
      cliHintPrefix: string;
      cliHintLink: string;
    };
    macHint: {
      trigger: string;
      title: string;
      sub: string;
      stepInstall: string;
      stepCommand: string;
      stepReopen: string;
      altSettings: string;
      noAutoUpdate: string;
      copyLabel: string;
      copiedLabel: string;
      close: string;
      confirm: string;
    };
    allPlatforms: {
      title: string;
      macArm64Label: string;
      macX64Label: string;
      winX64Label: string;
      winArm64Label: string;
      linuxX64Label: string;
      linuxArm64Label: string;
      formatDmg: string;
      formatZip: string;
      formatExe: string;
      formatAppImage: string;
      formatDeb: string;
      formatRpm: string;
      unavailable: string;
    };
    cli: {
      title: string;
      sub: string;
      installLabel: string;
      platformGroup: string;
      platformMacosLinux: string;
      platformWindows: string;
      startLabel: string;
      sshNote: string;
      copyLabel: string;
      copiedLabel: string;
    };
    footer: {
      releaseNotes: string;
      allReleases: string;
      currentVersion: string;
      versionUnavailable: string;
    };
  };
  contactSales: {
    pageTitle: string;
    pageDescription: string;
    eyebrow: string;
    title: string;
    fields: {
      firstName: string;
      lastName: string;
      businessEmail: string;
      businessEmailHint: string;
      companyName: string;
      companySize: string;
      countryRegion: string;
      useCase: string;
      goals: string;
      selectPlaceholder: string;
      submit: string;
      submitting: string;
    };
    companySizes: ContactSalesOption[];
    useCases: ContactSalesOption[];
    countries: string[];
    consent: {
      intro: string;
      outreach: string;
      updates: string;
      unsubscribe: string;
      submitConsent: string;
      privacyLinkLabel: string;
      privacyLinkHref: string;
    };
    success: { title: string; message: string; cta: string };
    errors: {
      generic: string;
      rateLimit: string;
      freeEmail: string;
      invalidEmail: string;
    };
  };
};
