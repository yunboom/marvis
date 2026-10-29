import { githubUrl, discordUrl } from "../components/shared";
import type { LandingDict } from "./types";

export function createEnDict(
  allowSignup: boolean,
  docsHref: string,
): LandingDict {
  return {
  header: {
    cta: "Get started",
    dashboard: "Dashboard",
    changelog: "Changelog",
    navigation: "Primary navigation",
    openMenu: "Open navigation menu",
    closeMenu: "Close navigation menu",
  },

  hero: {
    headlineLine1: "Hand work to agents",
    headlineLine2: "like you would to a teammate.",
    subheading:
      "Humans and agents, working in one place.",
    downloadDesktop: "Download Desktop",
    imageAlt: "Marvis board view \u2014 issues managed by humans and agents",
  },

  howItWorks: {
    headline: "Hire your first AI employee in an hour.",
    steps: [
      allowSignup
        ? { title: "Sign up, create a workspace", description: "Verify your email and you're in." }
        : { title: "Sign in to your workspace", description: "Verify your email to sign in." },
      { title: "Connect your computer", description: "Run marvis setup." },
      { title: "Create an agent", description: "Name it, write instructions, add skills." },
      { title: "Assign a task", description: "Assign it like a teammate and watch it work." },
    ],
    ctaGithub: "View on GitHub",
    ctaDocs: "Read the docs",
  },

  footer: {
    tagline:
      "Project management for human + agent teams. Source-available, self-hostable, built for the future of work.",
    cta: "Get started",
    groups: {
      product: {
        label: "Product",
        links: [
          { label: "How it Works", href: "#how-it-works" },
          { label: "Changelog", href: "/changelog" },
          { label: "Download", href: "/download" },
        ],
      },
      resources: {
        label: "Resources",
        links: [
          { label: "Documentation", href: docsHref },
          { label: "API", href: githubUrl },
          { label: "X (Twitter)", href: "https://x.com/MarvisAI" },
          { label: "Discord", href: discordUrl },
        ],
      },
      company: {
        label: "Company",
        links: [
          { label: "Licensing", href: "/licensing" },
          { label: "Contact Sales", href: "/contact-sales" },
          { label: "GitHub", href: githubUrl },
        ],
      },
    },
    copyright: "\u00a9 {year} Marvis. All rights reserved.",
  },

  licensing: {
    title: "Licensing",
    intro: [
      "Marvis is released under the [Marvis License](https://github.com/yunboom/marvis/blob/main/LICENSE): the Apache License 2.0 with a few additional conditions. The source code is public, and using Marvis inside your own organization is free, including self-hosting it for your whole team.",
      "The main additional condition covers hosted use: offering Marvis to people outside your organization requires a commercial license. This page shows where that line falls, using the questions we hear most often. It is a plain-language guide, not legal advice. If anything here differs from the LICENSE, the LICENSE controls.",
    ],
    rule: {
      title: "The rule of thumb",
      text: "Is anyone outside your organization driving the instance — creating issues, talking to agents, or triggering work? If so, through any interface (web, Slack, or API), that is a hosted service. If they only receive results your team produced with Marvis, that is internal use.",
    },
    scenarios: {
      title: "Common scenarios",
      scenarioColumn: "Scenario",
      licenseColumn: "Commercial license",
      required: "Required",
      notRequired: "Not required",
      items: [
        {
          scenario: "Your organization uses Marvis internally",
          example: "Self-hosted, across any number of workspaces.",
          required: false,
        },
        {
          scenario:
            "You deploy Marvis for a client, who owns it and uses it internally",
          example: "Implementation, training, consulting, or customization work.",
          required: false,
        },
        {
          scenario:
            "Your team uses Marvis to do work for clients, who only receive the deliverables",
          example:
            "An agency that runs its content production in Marvis and ships the finished work.",
          required: false,
        },
        {
          scenario:
            "Agents only push reports or notifications to a client\u2019s Slack channel",
          example:
            "The client reads them but never interacts with the instance.",
          required: false,
        },
        {
          scenario:
            "You run and manage Marvis instances for clients on your own infrastructure",
          example: "A managed service, whether or not you charge for it.",
          required: true,
        },
        {
          scenario: "People outside your organization sign in to your instance",
          example: "Clients, partners, or the public get their own accounts.",
          required: true,
        },
        {
          scenario:
            "People outside your organization drive your instance through another entry point",
          example:
            "A public website backed by Marvis, a Slack integration, or an API \u2014 even when it is free.",
          required: true,
        },
        {
          scenario: "You embed Marvis in a product you sell or distribute",
          example: "Marvis ships as a component of another commercial offering.",
          required: true,
        },
      ],
    },
    sections: [
      {
        heading: "Other conditions",
        bullets: [
          "Branding: keep the Marvis logo, product name, and the copyright and attribution information shown in the Marvis interface, unless we have given you a written branding waiver.",
          "Attribution: if you build on Marvis\u2019s backend, daemon, or CLI without the Marvis interface, keep the copyright and NOTICE information, and state in your user-facing documentation that your product is built on Marvis, with a link to the [GitHub repository](https://github.com/yunboom/marvis).",
          "Forks: publishing the source code of a fork is not a hosted service and needs no commercial license. Anyone who operates a hosted service from that fork needs their own.",
          "A commercial license and a branding waiver are separate grants. One does not include the other.",
        ],
      },
      {
        heading: "Getting a commercial license",
        paragraphs: [
          "Tell us about your use case through [Contact Sales](/contact-sales) and we\u2019ll get back to you within three business days. Not sure whether your setup needs a license? Ask us on [Discord](" + discordUrl + ") or through the same form.",
        ],
      },
    ],
  },

  changelog: {
    title: "Changelog",
    subtitle: "New updates and improvements to Marvis.",
    toc: "All releases",
    categories: {
      features: "New Features",
      improvements: "Improvements",
      fixes: "Bug Fixes",
    },
    entries: [
      {
        version: "0.0.1",
        date: "2026-10-28",
        title: "The first Marvis release",
        changes: [
          "Humans and agents work in one place. Assign a task to an agent the way you would to a teammate.",
        ],
      },
    ],
  },
  download: {
    hero: {
      macArm64: {
        title: "Marvis for macOS",
        sub: "Apple Silicon · bundled daemon, zero setup",
        primary: "Download (.dmg)",
        altZip: "or download .zip",
      },
      macIntel: {
        title: "Marvis for macOS",
        sub: "Intel · bundled daemon, zero setup",
        primary: "Download (.dmg)",
        altZip: "or download .zip",
      },
      winX64: {
        title: "Marvis for Windows",
        sub: "Bundled daemon, zero setup",
        primary: "Download (.exe)",
      },
      winArm64: {
        title: "Marvis for Windows",
        sub: "ARM · bundled daemon, zero setup",
        primary: "Download (.exe)",
      },
      linux: {
        title: "Marvis for Linux",
        sub: "Bundled daemon, zero setup",
        primary: "Download AppImage",
        altFormats: "or .deb / .rpm",
      },
      unknown: {
        title: "Choose your platform",
        sub: "All installers are listed below.",
      },
      safariMacHint: "On an Intel Mac? Choose the Intel download below.",
      archFallbackHint: "Wrong architecture? See all formats below.",
    },
    releases: {
      back: "Download",
      title: "All releases",
      sub: "Open a version and pick your platform.",
      latest: "Latest",
      notesLink: "Release notes",
      expand: "Show installers",
      collapse: "Hide installers",
      empty: "The release list is unavailable right now",
    },
    releaseDetail: {
      back: "All releases",
      notesTitle: "Release notes",
      notesFallback: "Maintenance release with no feature changes.",
      viewChangelog: "View changelog",
      downloadsTitle: "Download",
      cliHintPrefix: "To install the CLI and daemon, see the ",
      cliHintLink: "download page",
    },
    macHint: {
      trigger: "First launch on Mac",
      title: "Opening Marvis on a Mac for the first time",
      sub: "The app isn't signed by Apple yet, so macOS blocks the first launch. You only need to do this once.",
      stepInstall: "Open the .dmg and drag Marvis into Applications.",
      stepCommand: "If macOS says the app is damaged or the developer can't be verified, run this in Terminal:",
      stepReopen: "Open Marvis again.",
      altSettings: "Without Terminal: open System Settings › Privacy & Security and click Open Anyway at the bottom.",
      noAutoUpdate: "Automatic updates aren't available yet. Download new versions from the download page.",
      copyLabel: "Copy",
      copiedLabel: "Copied",
      close: "Close",
      confirm: "Got it",
    },
    allPlatforms: {
      title: "All platforms",
      macArm64Label: "macOS · Apple Silicon",
      macX64Label: "macOS · Intel",
      winX64Label: "Windows · x64",
      winArm64Label: "Windows · ARM64",
      linuxX64Label: "Linux · x64",
      linuxArm64Label: "Linux · ARM64",
      formatDmg: ".dmg",
      formatZip: ".zip",
      formatExe: ".exe",
      formatAppImage: ".AppImage",
      formatDeb: ".deb",
      formatRpm: ".rpm",
      unavailable: "Not available",
    },
    cli: {
      title: "Prefer the CLI?",
      sub: "For servers, remote dev boxes, and headless setups. Same daemon as Desktop, installed via terminal.",
      installLabel: "Install",
      platformGroup: "Choose your platform",
      platformMacosLinux: "macOS / Linux",
      platformWindows: "Windows",
      startLabel: "Start daemon",
      sshNote: "Already on a server? Same commands work over SSH.",
      copyLabel: "Copy",
      copiedLabel: "Copied",
    },
    footer: {
      releaseNotes: "What’s new in {version}",
      allReleases: "View all releases",
      currentVersion: "Current version: {version}",
      versionUnavailable: "Version unavailable",
    },
  },
  contactSales: {
    pageTitle: "Contact Sales",
    pageDescription:
      "Talk to the Marvis team about rolling out human + agent workflows at your company.",
    eyebrow: "Contact Sales",
    title: "Let’s understand your needs",
    fields: {
      firstName: "First name",
      lastName: "Last name",
      businessEmail: "Business email",
      businessEmailHint:
        "Use a company email. Gmail, Outlook, and other personal email providers aren't accepted.",
      companyName: "Company name",
      companySize: "Company size",
      countryRegion: "Country / Region",
      useCase: "How do you plan to use or collaborate with Marvis?",
      goals: "Your goals or challenges",
      selectPlaceholder: "Please select",
      submit: "Submit",
      submitting: "Submitting…",
    },
    companySizes: [
      { value: "1-10", label: "1 – 10 employees" },
      { value: "11-50", label: "11 – 50 employees" },
      { value: "51-200", label: "51 – 200 employees" },
      { value: "201-500", label: "201 – 500 employees" },
      { value: "501-1000", label: "501 – 1,000 employees" },
      { value: "1000+", label: "1,000+ employees" },
    ],
    useCases: [
      { value: "evaluate", label: "Evaluating Marvis for my team" },
      { value: "adopt_team", label: "Rolling out Marvis to a team or company" },
      { value: "self_host", label: "Self-hosting on our own infrastructure" },
      { value: "integrate", label: "Integrating Marvis with existing tools" },
      { value: "partner", label: "Partnership or reseller inquiry" },
      { value: "other", label: "Something else" },
    ],
    countries: [
      "United States",
      "Canada",
      "United Kingdom",
      "Germany",
      "France",
      "Netherlands",
      "Sweden",
      "Switzerland",
      "Spain",
      "Italy",
      "Ireland",
      "Norway",
      "Denmark",
      "Finland",
      "Belgium",
      "Portugal",
      "Australia",
      "New Zealand",
      "Japan",
      "South Korea",
      "Singapore",
      "Hong Kong SAR",
      "Taiwan",
      "China (Mainland)",
      "India",
      "Indonesia",
      "Thailand",
      "Vietnam",
      "Philippines",
      "Malaysia",
      "United Arab Emirates",
      "Saudi Arabia",
      "Israel",
      "Turkey",
      "South Africa",
      "Brazil",
      "Mexico",
      "Argentina",
      "Chile",
      "Other",
    ],
    consent: {
      intro:
        "Marvis respects your privacy. We’ll use your personal information only to manage your account and deliver the products or services you’ve requested. Occasionally, we’d love to share product updates, best practices, and insights that may be relevant to you. Please let us know below if you’d like to hear from us.",
      outreach:
        "I’d like to receive one-to-one communication from Marvis, including service updates, support inquiries, and business-related follow-ups.",
      updates:
        "I’d like to receive product updates, insights, and event invitations from Marvis.",
      unsubscribe:
        "You can unsubscribe from our communications at any time. For more details on how we handle your data and privacy rights, please review our",
      submitConsent:
        "By clicking “Submit,” you consent to allow Marvis to store and process your information for the purpose of delivering the requested content.",
      privacyLinkLabel: "Privacy Policy.",
      privacyLinkHref: "/privacy",
    },
    success: {
      title: "Thanks — we got it.",
      message:
        "A member of the Marvis team will respond within three business days. In the meantime, feel free to explore the docs or star us on GitHub.",
      cta: "Back to home",
    },
    errors: {
      generic: "Something went wrong — please try again in a moment.",
      rateLimit:
        "We’ve received a few inquiries from this address recently. Please try again in a little while.",
      freeEmail:
        "Please use a business email address — free providers (gmail, outlook, etc.) are not accepted.",
      invalidEmail: "That doesn’t look like a valid email address.",
    },
  },
  };
}
