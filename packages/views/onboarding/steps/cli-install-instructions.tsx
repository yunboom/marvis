"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { TooltipHint } from "@marvis/ui/components/common/tooltip-hint";
import { CODE_LIGATURE_CLASS } from "@marvis/ui/lib/code-style";
import { cn } from "@marvis/ui/lib/utils";
import { copyText } from "@marvis/ui/lib/clipboard";
import { CliInstallCommand } from "../../common/cli-install-command";
import { useT } from "../../i18n";

const SETUP_CMD = "marvis setup";

function CopyButton({ text }: { text: string }) {
  const { t } = useT("onboarding");
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <TooltipHint label={t(($) => $.cli_install.copy_aria)}>
      <button
        type="button"
        onClick={handleCopy}
        className="flex size-[22px] shrink-0 items-center justify-center rounded-xs text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:text-foreground"
        aria-label={t(($) => $.cli_install.copy_aria)}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-success" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </TooltipHint>
  );
}

function CommandRow({ cmd }: { cmd: string }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 rounded-lg bg-field px-3 py-2.5 font-mono text-label">
      <code
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-all",
          CODE_LIGATURE_CLASS,
        )}
      >
        {cmd}
      </code>
      <CopyButton text={cmd} />
    </div>
  );
}

function Step({
  n,
  label,
  children,
}: {
  n: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden
        className="flex size-[22px] shrink-0 items-center justify-center rounded-full bg-surface-sunken text-caption font-semibold"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="mt-px text-label text-muted-foreground">{label}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * CLI install instructions — two copy-and-run commands. Step 1 is the public
 * install script, which differs per OS and so renders through
 * `CliInstallCommand`'s platform switch; step 2 is the cloud
 * `marvis setup`, hardcoded because the CLI itself knows the endpoints for
 * it. Local development tests a self-host variant by typing the extended
 * command directly in the terminal; no need to thread env vars through React.
 */
export function CliInstallInstructions() {
  const { t } = useT("onboarding");
  return (
    <div className="flex flex-col gap-4">
      <Step n={1} label={t(($) => $.cli_install.step1_label)}>
        <CliInstallCommand
          labels={{
            group: t(($) => $.cli_install.platform_group),
            macosLinux: t(($) => $.cli_install.platform_macos_linux),
            windows: t(($) => $.cli_install.platform_windows),
          }}
          classNames={{ list: "mt-1.5" }}
        >
          {(cmd) => <CommandRow cmd={cmd} />}
        </CliInstallCommand>
      </Step>
      <Step n={2} label={t(($) => $.cli_install.step2_label)}>
        <CommandRow cmd={SETUP_CMD} />
      </Step>
    </div>
  );
}
