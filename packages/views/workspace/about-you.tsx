"use client";

import { type ReactNode, useState } from "react";
import {
  Brain,
  Briefcase,
  Code2,
  Compass,
  FileEdit,
  GraduationCap,
  ListChecks,
  Megaphone,
  MoreHorizontal,
  Palette,
  PenLine,
  Rocket,
  Search,
  Settings2,
  User,
} from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@marvis/ui/components/ui/dialog";
import { cn } from "@marvis/ui/lib/utils";
import type { Role, UseCase } from "@marvis/core/onboarding";
import { useT } from "../i18n";

/** Defaults the create page starts from; most members arrive to ship code. */
export const DEFAULT_ROLE: Role = "engineer";
export const DEFAULT_USE_CASES: UseCase[] = ["ship_code"];

const ROLE_ICONS: Record<Role, ReactNode> = {
  engineer: <Code2 />,
  product: <Briefcase />,
  designer: <Palette />,
  founder: <Rocket />,
  marketing: <Megaphone />,
  writer: <PenLine />,
  research: <Search />,
  ops: <Settings2 />,
  student: <GraduationCap />,
  other: <MoreHorizontal />,
};

const USE_CASE_ICONS: Record<UseCase, ReactNode> = {
  ship_code: <Code2 />,
  manage_team: <ListChecks />,
  personal_tasks: <User />,
  plan_research: <Brain />,
  write_publish: <FileEdit />,
  automate_ops: <Settings2 />,
  evaluate: <Compass />,
  other: <MoreHorizontal />,
};

const ROLES = Object.keys(ROLE_ICONS) as Role[];
const USE_CASES = Object.keys(USE_CASE_ICONS) as UseCase[];

// 选项胶囊：36 高；选中黑描边加内描边，悬停时仍能看出选中。
const CHIP =
  "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-label transition-[border-color,box-shadow] duration-(--motion-fast) ease-out [&_svg]:size-3.5 disabled:opacity-50";
const CHIP_ON =
  "border-foreground font-medium shadow-[inset_0_0_0_1px_var(--color-foreground)]";
const CHIP_OFF = "border-input text-foreground hover:border-foreground/40 [&_svg]:text-muted-foreground";

/**
 * "About you" on the create-workspace page: a one-line summary of the role and
 * use cases, with the full choice in a dialog so the page stays short. Edits
 * in the dialog are a draft until Done.
 */
export function AboutYouSummary({
  role,
  useCases,
  onChange,
  disabled,
}: {
  role: Role;
  useCases: UseCase[];
  onChange: (next: { role: Role; useCases: UseCase[] }) => void;
  disabled?: boolean;
}) {
  const { t } = useT("workspace");
  const [open, setOpen] = useState(false);
  const [draftRole, setDraftRole] = useState(role);
  const [draftUseCases, setDraftUseCases] = useState(useCases);

  const handleOpenChange = (next: boolean) => {
    // Every open starts from the confirmed answers, so Cancel discards edits.
    if (next) {
      setDraftRole(role);
      setDraftUseCases(useCases);
    }
    setOpen(next);
  };

  const toggleUseCase = (value: UseCase) => {
    setDraftUseCases((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value],
    );
  };

  const labelForRole = (value: Role) => t(($) => $.create_page.about.role[value]);
  const labelForUseCase = (value: UseCase) =>
    t(($) => $.create_page.about.use_case[value]);

  const [firstUseCase] = useCases;
  const useCaseSummary = !firstUseCase
    ? t(($) => $.create_page.about.uses_none)
    : useCases.length === 1
      ? labelForUseCase(firstUseCase)
      : t(($) => $.create_page.about.uses_more, {
          first: labelForUseCase(firstUseCase),
          count: useCases.length,
          rest: useCases.length - 1,
        });

  return (
    <div className="flex flex-col gap-2">
      <span id="about-you-label" className="text-body font-medium">
        {t(($) => $.create_page.about.label)}
      </span>
      <div
        role="group"
        aria-labelledby="about-you-label"
        className="flex h-15 items-center gap-3 rounded-lg bg-surface pr-2 pl-3.5 ring-1 ring-surface-border"
      >
        <span
          aria-hidden
          className="flex size-7.5 shrink-0 items-center justify-center rounded-md bg-surface-sunken [&_svg]:size-3.5"
        >
          {ROLE_ICONS[role]}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body font-medium">{labelForRole(role)}</span>
          <span className="truncate text-caption text-muted-foreground">
            {useCaseSummary}
          </span>
        </span>
        <Dialog open={open} onOpenChange={handleOpenChange}>
          <DialogTrigger
            render={
              <Button
                variant="secondary"
                size="sm"
                className="h-8 shrink-0 px-3.5 text-label font-normal"
                disabled={disabled}
              />
            }
          >
            {t(($) => $.create_page.about.edit)}
          </DialogTrigger>
          <DialogContent className="sm:max-w-[560px]">
            <DialogHeader>
              <DialogTitle>{t(($) => $.create_page.about.label)}</DialogTitle>
              <DialogDescription>
                {t(($) => $.create_page.about.dialog_hint)}
              </DialogDescription>
            </DialogHeader>

            <ChoiceGroup
              legend={t(($) => $.create_page.about.role.question)}
              role="radiogroup"
            >
              {ROLES.map((value) => (
                <Chip
                  key={value}
                  role="radio"
                  checked={draftRole === value}
                  icon={ROLE_ICONS[value]}
                  onClick={() => setDraftRole(value)}
                >
                  {labelForRole(value)}
                </Chip>
              ))}
            </ChoiceGroup>

            <ChoiceGroup
              legend={t(($) => $.create_page.about.use_case.question)}
              hint={t(($) => $.create_page.about.multi)}
              role="group"
            >
              {USE_CASES.map((value) => (
                <Chip
                  key={value}
                  role="checkbox"
                  checked={draftUseCases.includes(value)}
                  icon={USE_CASE_ICONS[value]}
                  onClick={() => toggleUseCase(value)}
                >
                  {labelForUseCase(value)}
                </Chip>
              ))}
            </ChoiceGroup>

            <DialogFooter>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t(($) => $.create_page.cancel)}
              </Button>
              <Button
                onClick={() => {
                  onChange({ role: draftRole, useCases: draftUseCases });
                  setOpen(false);
                }}
              >
                {t(($) => $.create_page.about.done)}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function ChoiceGroup({
  legend,
  hint,
  role,
  children,
}: {
  legend: string;
  hint?: string;
  role: "radiogroup" | "group";
  children: ReactNode;
}) {
  return (
    <fieldset className="mt-2 min-w-0">
      <legend className="text-body font-medium">
        {legend}
        {hint ? (
          <span className="font-normal text-muted-foreground">{` ${hint}`}</span>
        ) : null}
      </legend>
      <div role={role} aria-label={legend} className="mt-2.5 flex flex-wrap gap-2">
        {children}
      </div>
    </fieldset>
  );
}

function Chip({
  role,
  checked,
  icon,
  onClick,
  children,
}: {
  role: "radio" | "checkbox";
  checked: boolean;
  icon: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onClick}
      className={cn(CHIP, checked ? CHIP_ON : CHIP_OFF)}
    >
      {icon}
      {children}
    </button>
  );
}
