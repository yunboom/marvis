"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Lock, Search, X } from "lucide-react";
import {
  Alarm,
  Bell,
  ChatCircleDots,
  CreditCard,
  GearSix,
  GitBranch,
  HardDrives,
  Key,
  Keyboard,
  Laptop,
  Lightning,
  ListChecks,
  ListPlus,
  Plug,
  PlugsConnected,
  PuzzlePiece,
  SlidersHorizontal,
  Tag,
  UserCircle,
  UsersThree,
} from "@phosphor-icons/react/ssr";
import { useAuthStore } from "@marvis/core/auth";
import { useCurrentWorkspace } from "@marvis/core/paths";
import { useFeatureEnabled } from "@marvis/core/config";
import { useCurrentMember } from "@marvis/core/permissions";
import {
  BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG,
  PLUGINS_V1_FLAG,
} from "@marvis/core/feature-flags";
import { resolvePublicFileUrl } from "@marvis/core/workspace/avatar-url";
import { ActorAvatar } from "@marvis/ui/components/common/actor-avatar";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { cn } from "@marvis/ui/lib/utils";
import { resolveSettingsLocation, settingsHref } from "./settings-navigation";
import { AppLink, useNavigation } from "../../navigation";
import { WorkspaceAvatar } from "../../workspace/workspace-avatar";
import { AccountTab } from "./account-tab";
import { PreferencesTab } from "./preferences-tab";
import { TokensTab } from "./tokens-tab";
import { WorkspaceTab } from "./workspace-tab";
import { MembersTab } from "./members-tab";
import { CodeTab } from "./code-tab";
import { ChannelsTab } from "./channels-tab";
import { ConnectedAppsTab, useComposioAvailable } from "./connected-apps-tab";
import { NotificationsTab } from "./notifications-tab";
import { LabelsTab } from "./labels-tab";
import { PropertiesTab } from "./properties-tab";
import { QuickActionsTab } from "./quick-actions-tab";
import { KeyboardShortcutsTab } from "./keyboard-shortcuts-tab";
import { PluginsTab } from "./plugins-tab";
import { McpTab } from "./mcp-tab";
import { BillingTab } from "./billing-tab";
import { SETTINGS_ANCHOR_ATTR } from "./settings-layout";
import { searchSettings } from "./settings-search";
import { HighlightText } from "../../search/highlight-text";
import { useSettingsSearchIndex } from "./use-settings-search-index";
import { WakeupsTab } from "./wakeups-tab";
import { CollapsedNavTrigger } from "../../layout/page-header";
import { filled } from "../../layout/route-icon-components";
import { useT } from "../../i18n";

export interface ExtraSettingsTab {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  content: React.ReactNode;
}

interface SettingsPageProps {
  /** Device settings supplied by the desktop platform. */
  extraDeviceTabs?: ExtraSettingsTab[];
}

type SettingsEntry = ExtraSettingsTab & {
  wide?: boolean;
  /** Owners and admins manage it; members see a read-only page. */
  adminOnly?: boolean;
};

interface SettingsSubgroup {
  key: string;
  label?: string;
  /** Labelled subgroups render as a collapsible row with this icon. */
  icon?: ExtraSettingsTab["icon"];
  entries: SettingsEntry[];
}

interface SettingsScopeGroup {
  key: "personal" | "workspace" | "device";
  label: string;
  /** Leading mark: whose settings these are. */
  mark: React.ReactNode;
  /** Trailing detail (the user's name, "Workspace"). */
  tag?: string;
  subgroups: SettingsSubgroup[];
}

/** Nav icons share the sidebar's solid glyph style. */
const ICONS = {
  profile: filled(UserCircle),
  preferences: filled(SlidersHorizontal),
  notifications: filled(Bell),
  keyboard: filled(Keyboard),
  apps: filled(PlugsConnected),
  tokens: filled(Key),
  workspace: filled(GearSix),
  members: filled(UsersThree),
  billing: filled(CreditCard),
  wakeups: filled(Alarm),
  labels: filled(Tag),
  properties: filled(ListPlus),
  autopilot: filled(Lightning),
  code: filled(GitBranch),
  chat: filled(ChatCircleDots),
  mcp: filled(HardDrives),
  plugins: filled(PuzzlePiece),
  issues: filled(ListChecks),
  connections: filled(Plug),
};

const FLASH_MS = 1600;
const ANCHOR_WAIT_MS = 1500;

export function SettingsPage({ extraDeviceTabs = [] }: SettingsPageProps = {}) {
  const { t } = useT("settings");
  const workspace = useCurrentWorkspace();
  const workspaceName = workspace?.name ?? t(($) => $.page.workspace_fallback);
  const user = useAuthStore((s) => s.user);
  const { role } = useCurrentMember(workspace?.id ?? "");
  const isMember = role === "member";
  const navigation = useNavigation();
  const pluginsEnabled = useFeatureEnabled(PLUGINS_V1_FLAG, false);
  const billingEnabled = useFeatureEnabled(
    BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG,
    false,
  );
  const appsAvailable = useComposioAvailable();
  const entry = (
    value: string,
    label: string,
    icon: ExtraSettingsTab["icon"],
    content: React.ReactNode,
    options: { wide?: boolean; adminOnly?: boolean } = {},
  ): SettingsEntry => ({ value, label, icon, content, ...options });

  const groups: SettingsScopeGroup[] = [
    {
      key: "personal",
      label: t(($) => $.page.groups.personal),
      mark: (
        <ActorAvatar
          name={user?.name ?? ""}
          initials={(user?.name ?? "U").charAt(0).toUpperCase()}
          avatarUrl={resolvePublicFileUrl(user?.avatar_url)}
          size="xs"
        />
      ),
      tag: user?.name,
      subgroups: [
        {
          key: "personal",
          entries: [
            entry("profile", t(($) => $.page.tabs.profile), ICONS.profile, <AccountTab />),
            entry(
              "preferences",
              t(($) => $.page.tabs.preferences),
              ICONS.preferences,
              <PreferencesTab />,
            ),
            entry(
              "notifications",
              t(($) => $.page.tabs.notifications),
              ICONS.notifications,
              <NotificationsTab />,
            ),
            entry(
              "shortcuts",
              t(($) => $.page.tabs.shortcuts),
              ICONS.keyboard,
              <KeyboardShortcutsTab />,
            ),
            ...(appsAvailable
              ? [entry("apps", t(($) => $.page.tabs.apps), ICONS.apps, <ConnectedAppsTab />)]
              : []),
            entry("tokens", t(($) => $.page.tabs.tokens), ICONS.tokens, <TokensTab />),
          ],
        },
      ],
    },
    {
      key: "workspace",
      label: workspaceName,
      mark: (
        <WorkspaceAvatar
          name={workspaceName}
          avatarUrl={workspace?.avatar_url}
          size="sm"
          className="size-4 rounded-xs"
        />
      ),
      tag: t(($) => $.page.groups.workspace),
      subgroups: [
        {
          key: "workspace",
          entries: [
            entry("workspace", t(($) => $.page.tabs.general), ICONS.workspace, <WorkspaceTab />, {
              adminOnly: true,
            }),
            entry("members", t(($) => $.page.tabs.members), ICONS.members, <MembersTab />, {
              adminOnly: true,
            }),
            ...(billingEnabled
              ? [
                  entry(
                    "billing",
                    t(($) => $.page.tabs.billing),
                    ICONS.billing,
                    <BillingTab />,
                  ),
                ]
              : []),
          ],
        },
        {
          key: "issues",
          label: t(($) => $.page.groups.issues),
          icon: ICONS.issues,
          entries: [
            entry("wakeups", t(($) => $.page.tabs.wakeups), ICONS.wakeups, <WakeupsTab />, {
              wide: true,
              adminOnly: true,
            }),
            entry("labels", t(($) => $.page.tabs.labels), ICONS.labels, <LabelsTab />, {
              wide: true,
            }),
            entry(
              "properties",
              t(($) => $.page.tabs.properties),
              ICONS.properties,
              <PropertiesTab />,
              { wide: true, adminOnly: true },
            ),
            entry(
              "quick-actions",
              t(($) => $.page.tabs.quick_actions),
              ICONS.autopilot,
              <QuickActionsTab />,
              { wide: true },
            ),
          ],
        },
        {
          key: "connections",
          label: t(($) => $.page.groups.connections),
          icon: ICONS.connections,
          entries: [
            entry("code", t(($) => $.page.tabs.code), ICONS.code, <CodeTab />, {
              adminOnly: true,
            }),
            entry(
              "channels",
              t(($) => $.page.tabs.channels),
              ICONS.chat,
              <ChannelsTab />,
            ),
            entry("mcp", t(($) => $.page.tabs.mcp), ICONS.mcp, <McpTab />, {
              adminOnly: true,
            }),
            ...(pluginsEnabled
              ? [
                  entry("plugins", t(($) => $.page.tabs.plugins), ICONS.plugins, <PluginsTab />, {
                    adminOnly: true,
                  }),
                ]
              : []),
          ],
        },
      ],
    },
    ...(extraDeviceTabs.length
      ? [
          {
            key: "device" as const,
            label: t(($) => $.page.groups.device),
            mark: <Laptop weight="fill" aria-hidden="true" className="size-4 text-foreground" />,
            subgroups: [{ key: "device", entries: extraDeviceTabs as SettingsEntry[] }],
          },
        ]
      : []),
  ];
  const allEntries = groups.flatMap((group) =>
    group.subgroups.flatMap((subgroup) => subgroup.entries),
  );
  const location = resolveSettingsLocation(navigation.searchParams);
  const candidate =
    location.tab === "billing" && !billingEnabled ? "workspace" : location.tab;
  const active =
    allEntries.find((item) => item.value === candidate) ?? allEntries[0]!;
  const href = (value: string) =>
    settingsHref(navigation.pathname, navigation.searchParams, value);

  const scopeOf = (value: string) =>
    groups.find((group) =>
      group.subgroups.some((subgroup) =>
        subgroup.entries.some((item) => item.value === value),
      ),
    );

  // 二级分组默认折叠；当前页所在的分组展开，跳转到折叠分组里的页面时自动展开。
  const activeSubgroup = groups
    .flatMap((group) => group.subgroups)
    .find((subgroup) => subgroup.entries.some((item) => item.value === active.value))?.key;
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    activeSubgroup ? { [activeSubgroup]: true } : {},
  );
  useEffect(() => {
    if (activeSubgroup) setExpanded((current) => (current[activeSubgroup] ? current : { ...current, [activeSubgroup]: true }));
  }, [activeSubgroup]);
  const toggleSubgroup = (key: string) =>
    setExpanded((current) => ({ ...current, [key]: !current[key] }));

  // --- search ---------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const searchPages = useMemo(
    () => allEntries.map((item) => ({ value: item.value, label: item.label })),
    // Labels are derived from i18n and flags; the value list is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allEntries.map((item) => `${item.value}:${item.label}`).join("|")],
  );
  const index = useSettingsSearchIndex(searchPages);
  const results = useMemo(() => searchSettings(index, query), [index, query]);
  const openResult = (position: number) => {
    const result = results[position];
    if (!result) return;
    setActiveResult(position);
    navigation.push(
      settingsHref(navigation.pathname, navigation.searchParams, result.tab, {
        section: result.anchor,
        integration: result.integration,
      }),
    );
  };

  // --- anchors --------------------------------------------------------------
  // Search results and legacy `?section=` links name an anchor inside the
  // page. Tab content can still be loading on the first frame, so wait briefly
  // for the anchor before scrolling it into view and flashing it.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const anchor = location.section;
    if (!anchor) return;
    let cancelled = false;
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const find = () => {
      if (cancelled) return;
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[${SETTINGS_ANCHOR_ATTR}="${CSS.escape(anchor)}"]`,
      );
      if (!target) {
        if (Date.now() - startedAt < ANCHOR_WAIT_MS) {
          requestAnimationFrame(find);
        }
        return;
      }
      const reduceMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      target.setAttribute("data-flash", "true");
      flashTimer = setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS);
    };
    requestAnimationFrame(find);
    return () => {
      cancelled = true;
      if (flashTimer) clearTimeout(flashTimer);
    };
  }, [active.value, location.section]);

  // nested：折叠分组里的子项，不带图标，文字与分组名对齐。
  const navItem = (item: SettingsEntry, nested = false) => (
    <li key={item.value}>
      <AppLink
        href={href(item.value)}
        aria-current={active.value === item.value ? "page" : undefined}
        className={cn(
          "flex h-7.5 items-center gap-2.5 rounded-row px-2.5 text-body transition-colors duration-(--motion-fast) ease-out hover:duration-(--motion-instant) focus-visible:outline-2 focus-visible:outline-ring",
          nested && "pl-9",
          active.value === item.value
            ? "bg-surface-selected font-medium text-surface-selected-foreground hover:bg-surface-selected"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        )}
      >
        {nested ? null : <item.icon className="size-4 shrink-0 text-foreground" aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {isMember && item.adminOnly ? (
          <Lock
            className="size-3 shrink-0 text-faint-foreground"
            aria-label={t(($) => $.page.admin_only)}
          />
        ) : null}
      </AppLink>
    </li>
  );

  const searchResults = (
    <div className="space-y-1">
      <p className="px-2.5 pb-1.5 pt-1 text-caption text-muted-foreground" role="status">
        {results.length > 0
          ? t(($) => $.page.search_results, { count: results.length })
          : t(($) => $.page.search_empty)}
      </p>
      <ul id="settings-search-results" role="listbox" aria-label={t(($) => $.page.search)}>
        {results.map((result, position) => {
          const page = allEntries.find((item) => item.value === result.tab);
          const scope = scopeOf(result.tab);
          const path = [scope?.label, result.anchor || result.integration ? page?.label : null]
            .filter(Boolean)
            .join(" › ");
          return (
            <li key={`${result.tab}#${result.anchor ?? ""}#${result.integration ?? ""}`}>
              <button
                type="button"
                role="option"
                aria-selected={position === activeResult}
                onClick={() => openResult(position)}
                onMouseMove={() => setActiveResult(position)}
                className={cn(
                  "w-full rounded-md px-2.5 py-2 text-left transition-colors duration-(--motion-fast) ease-out focus-visible:outline-2 focus-visible:outline-ring",
                  position === activeResult
                    ? "bg-surface-selected text-surface-selected-foreground"
                    : "hover:bg-surface-hover",
                )}
              >
                <span className="block truncate text-body">
                  <HighlightText text={result.title} query={query} />
                </span>
                {result.snippet ? (
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                    <HighlightText text={result.snippet} query={query} />
                  </span>
                ) : null}
                <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                  {path}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:flex-row">
      <aside className="shrink-0 border-b border-surface-border md:flex md:w-62 md:flex-col md:border-b-0 md:border-r">
        <div className="flex h-16 shrink-0 items-center gap-1 px-4 md:px-5.5">
          <CollapsedNavTrigger />
          <h1 className="text-title-lg font-bold">
            {t(($) => $.page.title)}
          </h1>
        </div>
        <div className="px-4 pb-4 md:hidden">
          <label className="sr-only" htmlFor="settings-navigation">
            {t(($) => $.page.navigate)}
          </label>
          <select
            id="settings-navigation"
            className="h-10 w-full rounded-lg border-0 bg-field px-3 text-body text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            value={active.value}
            onChange={(event) => navigation.push(href(event.target.value))}
          >
            {groups.flatMap((group) =>
              group.subgroups.map((subgroup) => (
                <optgroup
                  key={`${group.key}:${subgroup.key}`}
                  label={subgroup.label ? `${group.label} · ${subgroup.label}` : group.label}
                >
                  {subgroup.entries.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              )),
            )}
          </select>
        </div>
        <div className="relative mx-3 mb-2.5 hidden shrink-0 md:block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.75 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveResult(0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveResult((current) =>
                  Math.min(current + 1, Math.max(results.length - 1, 0)),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveResult((current) => Math.max(current - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                openResult(activeResult);
              } else if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder={t(($) => $.page.search)}
            aria-label={t(($) => $.page.search)}
            aria-controls={query ? "settings-search-results" : undefined}
            className="h-8.5 w-full rounded-lg border-0 bg-field pl-8 pr-8 text-label outline-none transition-colors placeholder:text-muted-foreground hover:bg-field-hover focus-visible:bg-field-hover focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-search-cancel-button]:hidden"
          />
          {query ? (
            <TooltipHint label={t(($) => $.page.search_clear)}>
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t(($) => $.page.search_clear)}
                className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-surface-hover hover:text-foreground"
              >
                <X className="size-3.25" aria-hidden="true" />
              </button>
            </TooltipHint>
          ) : null}
        </div>
        <nav
          aria-label={t(($) => $.page.title)}
          className="hidden min-h-0 overflow-y-auto px-3 pb-6 md:block"
        >
          {query ? (
            searchResults
          ) : (
            <div className="divide-y divide-surface-border">
              {groups.map((group) => (
                <section
                  key={group.key}
                  aria-labelledby={`settings-group-${group.key}`}
                  className="py-2.5 first:pt-0"
                >
                  <h2
                    id={`settings-group-${group.key}`}
                    className="flex h-7.5 min-w-0 items-center gap-2.5 px-2.5 text-label font-semibold text-foreground"
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {group.mark}
                    </span>
                    <span className="truncate">{group.label}</span>
                    {group.tag ? (
                      <span className="ml-auto shrink-0 truncate text-micro font-medium text-muted-foreground">
                        {group.tag}
                      </span>
                    ) : null}
                  </h2>
                  {group.subgroups.map((subgroup) => {
                    if (!subgroup.label) {
                      return (
                        <ul key={subgroup.key} className="space-y-px">
                          {subgroup.entries.map((item) => navItem(item))}
                        </ul>
                      );
                    }
                    const open = Boolean(expanded[subgroup.key]);
                    const Icon = subgroup.icon;
                    const Chevron = open ? ChevronUp : ChevronDown;
                    return (
                      <div key={subgroup.key} className="mt-px">
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={`settings-subgroup-${subgroup.key}`}
                          onClick={() => toggleSubgroup(subgroup.key)}
                          className="flex h-7.5 w-full items-center gap-2.5 rounded-row px-2.5 text-left text-body text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-surface-hover hover:text-foreground hover:duration-(--motion-instant) focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {Icon ? <Icon className="size-4 shrink-0 text-foreground" aria-hidden="true" /> : null}
                          <span className="min-w-0 flex-1 truncate">{subgroup.label}</span>
                          <Chevron className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                        </button>
                        {open ? (
                          <ul
                            id={`settings-subgroup-${subgroup.key}`}
                            aria-label={subgroup.label}
                            className="mt-px space-y-px"
                          >
                            {subgroup.entries.map((item) => navItem(item, true))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )}
        </nav>
      </aside>
      <div
        ref={contentRef}
        key={`${active.value}:${location.integration ?? ""}`}
        className="min-w-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className={cn(
            "mx-auto w-full px-4 py-6 sm:px-6 md:px-10 md:pt-8 md:pb-10",
            active.wide ? "max-w-5xl" : "max-w-[52.5rem]",
          )}
        >
          {active.content}
        </div>
      </div>
    </div>
  );
}
