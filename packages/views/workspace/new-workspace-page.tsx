"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { Dices, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@marvis/ui/components/ui/card";
import { Input } from "@marvis/ui/components/ui/input";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@marvis/ui/components/ui/field";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { cn } from "@marvis/ui/lib/utils";
import { useCreateWorkspace } from "@marvis/core/workspace/mutations";
import type { Workspace } from "@marvis/core/types";
import { isImeComposing } from "@marvis/core/utils";
import { matchLocale } from "@marvis/core/i18n";
import { useConfigStore } from "@marvis/core/config";
import { workspaceUrlHost } from "@marvis/core/workspace/workspace-url";
import { isReservedSlug } from "@marvis/core/paths";
import {
  saveQuestionnaire,
  type Role,
  type UseCase,
} from "@marvis/core/onboarding";
import { useLogout } from "../auth";
import { SetupProgress } from "../onboarding/components/setup-progress";
import { DragStrip } from "../platform";
import { useT } from "../i18n";
import { AboutYouSummary, DEFAULT_ROLE, DEFAULT_USE_CASES } from "./about-you";
import {
  WORKSPACE_SLUG_REGEX,
  isWorkspaceSlugConflict,
  nameToWorkspaceSlug,
  randomCelestialWorkspaceIdentity,
} from "./slug";

// The disabled notice keeps the auth pages' single card.
const CARD_CLASS =
  "w-full max-w-[440px] gap-0 rounded-2xl border-0 p-10 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border dark:shadow-none";
// The form sits on the sunken right pane, so fields are white with a hairline
// instead of the usual grey fill.
const FIELD_INPUT_CLASS =
  "h-12 bg-surface px-4 ring-1 ring-surface-border hover:bg-surface focus-visible:bg-surface focus-visible:ring-foreground/40";
// Field holding a borderless input beside a muted affix (URL host, sample
// issue number).
const AFFIX_FIELD =
  "flex h-12 items-center rounded-lg bg-surface px-4 ring-1 ring-surface-border transition-shadow focus-within:ring-foreground/40 in-data-[invalid=true]:ring-destructive";
const AFFIX_INPUT =
  "h-full rounded-none border-0 bg-transparent px-0 tabular-nums shadow-none hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-body";

function issuePrefix(slug: string): string {
  // Mirrors the server's default prefix derivation
  // (handler.defaultIssuePrefixFromSlug): alphanumerics of the lowercased
  // slug, first 4 chars, uppercased.
  return slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
}

// Same shape the server validates (`^[A-Z0-9]{1,10}$`).
function normalizePrefix(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
}

/**
 * Standalone create-workspace page, shared by the web `/workspaces/new` route
 * and the desktop new-workspace overlay. Users reach it right after login when
 * they have no workspace yet, or from the workspace switcher.
 *
 * `onCancel` is only passed when the user has a workspace to return to; a user
 * with none gets Log out as the way out instead. `askAboutYou` adds the role
 * and use-case summary during first-run onboarding; the answers are per
 * member, so creating another workspace does not ask again.
 */
export function NewWorkspacePage({
  onCreated,
  onCancel,
  askAboutYou = false,
}: {
  onCreated: (workspace: Workspace) => void;
  onCancel?: () => void;
  askAboutYou?: boolean;
}) {
  const { t } = useT("workspace");
  const logout = useLogout();
  const workspaceCreationDisabled = useConfigStore(
    (s) => s.workspaceCreationDisabled,
  );

  if (workspaceCreationDisabled) {
    return (
      <PageShell>
        <CardHeader className="gap-2 px-0 text-center">
          <h1 className="text-display-sm font-bold">
            {t(($) => $.create_page.disabled_title)}
          </h1>
          <CardDescription className="text-body-lg leading-relaxed">
            {t(($) => $.create_page.disabled_description)}
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-8 px-0">
          <Button
            variant="outline"
            className="h-12 w-full text-body-lg"
            onClick={logout}
          >
            {t(($) => $.create_page.log_out)}
          </Button>
        </CardContent>
      </PageShell>
    );
  }

  return (
    <CreateWorkspaceForm
      onCreated={onCreated}
      onCancel={onCancel}
      onLogout={logout}
      askAboutYou={askAboutYou}
    />
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-app-shell">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className={CARD_CLASS}>
          <MarvisIcon className="mx-auto mb-6 size-12" />
          {children}
        </Card>
      </div>
    </div>
  );
}

function CreateWorkspaceForm({
  onCreated,
  onCancel,
  onLogout,
  askAboutYou,
}: {
  onCreated: (workspace: Workspace) => void;
  onCancel?: () => void;
  onLogout: () => void;
  askAboutYou: boolean;
}) {
  const { t, i18n } = useT("workspace");
  const locale = matchLocale([i18n.resolvedLanguage ?? i18n.language]);
  const urlHost = workspaceUrlHost(useConfigStore((s) => s.daemonAppUrl));

  // The slug follows the name and the prefix follows the slug, each until the
  // user edits it by hand.
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugServerError, setSlugServerError] = useState<string | null>(null);
  const slugTouched = useRef(false);
  const [prefix, setPrefix] = useState("");
  const prefixTouched = useRef(false);
  const [role, setRole] = useState<Role>(DEFAULT_ROLE);
  const [useCases, setUseCases] = useState<UseCase[]>(DEFAULT_USE_CASES);

  const slugError =
    slug.length > 0 && !WORKSPACE_SLUG_REGEX.test(slug)
      ? t(($) => $.create_page.errors.slug_format)
      : slug.length > 0 && isReservedSlug(slug)
        ? t(($) => $.create_page.errors.slug_reserved)
        : slugServerError;

  // An empty prefix field falls back to the slug-derived default, which the
  // placeholder shows.
  const derivedPrefix = issuePrefix(slug);
  const effectivePrefix = prefix || derivedPrefix;

  const createWorkspace = useCreateWorkspace();
  const isCreating = createWorkspace.isPending;
  const canCreate =
    name.trim().length > 0 && slug.trim().length > 0 && !slugError;

  const applySlug = (value: string) => {
    setSlug(value);
    setSlugServerError(null);
    if (!prefixTouched.current) setPrefix(issuePrefix(value));
  };

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched.current) applySlug(nameToWorkspaceSlug(value, locale));
  };

  const handleSlugChange = (value: string) => {
    slugTouched.current = true;
    applySlug(value);
  };

  const handlePrefixChange = (value: string) => {
    prefixTouched.current = true;
    setPrefix(normalizePrefix(value));
  };

  const handleRandomName = () => {
    const identity = randomCelestialWorkspaceIdentity(locale);
    slugTouched.current = true;
    setName(identity.name);
    applySlug(identity.slug);
  };

  const handleCreate = () => {
    if (!canCreate || isCreating) return;

    // Fire-and-forget: the answers only shape the opening chat, which starts
    // after the runtime step, so a slow save never holds up the workspace.
    if (askAboutYou) {
      void saveQuestionnaire({
        role,
        role_skipped: false,
        use_case: useCases,
        use_case_skipped: useCases.length === 0,
        version: 2,
      }).catch((err) => {
        if (err instanceof Error) toast.error(err.message);
      });
    }

    createWorkspace.mutate(
      {
        name: name.trim(),
        slug: slug.trim(),
        issue_prefix: effectivePrefix,
      },
      {
        onSuccess: onCreated,
        onError: (error) => {
          if (isWorkspaceSlugConflict(error)) {
            setSlugServerError(t(($) => $.create_page.errors.slug_taken));
            toast.error(t(($) => $.create_page.errors.slug_conflict_toast));
            return;
          }
          toast.error(
            error instanceof Error && error.message
              ? error.message
              : t(($) => $.create_page.errors.create_failed),
          );
        },
      },
    );
  };

  const submitOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") handleCreate();
  };

  const trimmedName = name.trim();
  const previewLine = slug
    ? `${urlHost}/${slug} · ${effectivePrefix}-123`
    : t(($) => $.create_page.preview_empty_hint);

  // Two panes like the runtime step that follows: context and actions on the
  // left, the form on the right. Three grid children rather than two columns
  // so a phone stacks them intro → form → actions, with the button last.
  return (
    <div className="flex min-h-svh flex-col bg-app-shell">
      <DragStrip />
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-[960px] gap-0 overflow-hidden rounded-[28px] border-0 p-0 shadow-[0_24px_32px_rgba(0,0,0,0.06)] ring-1 ring-surface-border md:grid md:h-[600px] md:grid-cols-[380px_minmax(0,1fr)] md:grid-rows-[1fr_auto] dark:shadow-none">
          <div className="flex flex-col px-10 pt-10 md:col-start-1 md:row-start-1">
            <SetupProgress current="workspace" />

            <h1 className="mt-10 text-display-sm font-bold">
              {t(($) => $.create_page.title)}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-muted-foreground">
              {t(($) => $.create_page.subtitle)}
            </p>

            <div className="mt-7 flex items-center gap-3 rounded-2xl bg-surface-sunken px-3.5 py-3">
              <span
                aria-hidden
                className={cn(
                  "flex size-9 shrink-0 items-center justify-center rounded-[10px] text-body font-bold text-background",
                  trimmedName ? "bg-foreground" : "bg-input",
                )}
              >
                {trimmedName ? trimmedName.charAt(0).toUpperCase() : "?"}
              </span>
              <div className="min-w-0">
                <p
                  className={cn(
                    "truncate text-body font-semibold",
                    !trimmedName && "text-faint-foreground",
                  )}
                >
                  {trimmedName || t(($) => $.create_page.preview_empty_name)}
                </p>
                <p aria-live="polite" className="truncate text-caption text-muted-foreground">
                  {previewLine}
                </p>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col px-6 pt-8 md:col-start-2 md:row-span-2 md:row-start-1 md:py-8 md:pr-8 md:pl-2">
            <div className="flex flex-1 flex-col rounded-[20px] bg-surface-sunken p-7">
              <FieldGroup className="gap-6">
                <Field>
                  <FieldLabel htmlFor="new-ws-name">
                    {t(($) => $.create_page.name_label)}
                  </FieldLabel>
                  <div className="flex items-center gap-2">
                    <Input
                      id="new-ws-name"
                      autoFocus
                      type="text"
                      value={name}
                      disabled={isCreating}
                      onChange={(e) => handleNameChange(e.target.value)}
                      onKeyDown={submitOnEnter}
                      placeholder={t(($) => $.create_page.name_placeholder)}
                      className={cn(FIELD_INPUT_CLASS, "min-w-0 flex-1 md:text-body-lg")}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleRandomName}
                      disabled={isCreating}
                      className="h-12 shrink-0 gap-1.5 bg-surface px-[18px]"
                    >
                      <Dices className="size-4" />
                      {t(($) => $.create_page.random_name)}
                    </Button>
                  </div>
                </Field>

                {/* The prefix sits left of the URL it is derived from; its example
                    issue number rides inside the field the way the host does in the
                    URL, so neither needs a line of its own. */}
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-[128px_minmax(0,1fr)] gap-2">
                    <Field>
                      <FieldLabel htmlFor="new-ws-prefix">
                        {t(($) => $.create_page.issue_prefix_label)}
                      </FieldLabel>
                      <div className={AFFIX_FIELD}>
                        <Input
                          id="new-ws-prefix"
                          type="text"
                          value={prefix}
                          disabled={isCreating}
                          onChange={(e) => handlePrefixChange(e.target.value)}
                          onKeyDown={submitOnEnter}
                          placeholder={derivedPrefix}
                          autoComplete="off"
                          autoCapitalize="characters"
                          spellCheck={false}
                          maxLength={10}
                          aria-describedby="new-ws-prefix-sample"
                          // w-auto overrides the Input's w-full so the field sizes to
                          // its content and the sample number sits right after it.
                          className={cn(AFFIX_INPUT, "w-auto min-w-[1ch] max-w-full flex-none field-sizing-content uppercase")}
                        />
                        {effectivePrefix ? (
                          <span
                            id="new-ws-prefix-sample"
                            className="shrink-0 select-none text-body tabular-nums text-muted-foreground"
                          >
                            -123
                          </span>
                        ) : null}
                      </div>
                    </Field>

                    <Field data-invalid={slugError ? true : undefined}>
                      <FieldLabel htmlFor="new-ws-slug">
                        {t(($) => $.create_page.url_label)}
                      </FieldLabel>
                      <div className={AFFIX_FIELD}>
                        <span className="shrink-0 select-none text-body text-muted-foreground">
                          {`${urlHost}/`}
                        </span>
                        <Input
                          id="new-ws-slug"
                          type="text"
                          value={slug}
                          disabled={isCreating}
                          onChange={(e) => handleSlugChange(e.target.value)}
                          onKeyDown={submitOnEnter}
                          placeholder={t(($) => $.create_page.slug_placeholder)}
                          className={AFFIX_INPUT}
                        />
                      </div>
                    </Field>
                  </div>
                  {slugError ? (
                    <FieldError className="text-label">{slugError}</FieldError>
                  ) : null}
                </div>

                {askAboutYou ? (
                  <AboutYouSummary
                    role={role}
                    useCases={useCases}
                    disabled={isCreating}
                    onChange={(next) => {
                      setRole(next.role);
                      setUseCases(next.useCases);
                    }}
                  />
                ) : null}
              </FieldGroup>
            </div>
          </div>

          <div className="flex flex-col px-10 pt-8 pb-9 md:col-start-1 md:row-start-2">
            <Button
              className="h-12 w-full text-body-lg"
              disabled={!canCreate || isCreating}
              onClick={handleCreate}
            >
              {isCreating && <Loader2 className="size-4 animate-spin" />}
              {isCreating
                ? t(($) => $.create_page.submitting)
                : t(($) => $.create_page.submit)}
            </Button>

            {onCancel ? (
              <Button
                variant="ghost"
                className="mt-2 h-11 w-full text-body-lg font-normal"
                disabled={isCreating}
                onClick={onCancel}
              >
                {t(($) => $.create_page.cancel)}
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="mt-2 h-11 w-full text-label font-normal text-muted-foreground"
                disabled={isCreating}
                onClick={onLogout}
              >
                {t(($) => $.create_page.log_out)}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
