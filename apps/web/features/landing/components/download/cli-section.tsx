"use client";

import { useState, type ReactNode } from "react";
import { CliInstallCommand } from "@marvis/views/common/cli-install-command";
import { copyText } from "@marvis/ui/lib/clipboard";
import { useLocale } from "../../i18n";

const SETUP_CMD = "marvis setup";

const COPIED_RESET_MS = 1800;

/**
 * The landing palette bypasses the product tokens, so the shared platform
 * switch takes its list and trigger colours from here.
 */
const PLATFORM_TABS = {
  list: "rounded-full bg-[#f2f2f2] p-1",
  trigger:
    "h-[30px] rounded-full px-3.5 text-[13px] text-[#666] hover:text-[#0f0f0f] data-active:bg-white data-active:text-[#0f0f0f]",
};

/**
 * Scenario-first CLI section. Copy leans into servers / remote dev
 * boxes / headless setups rather than positioning CLI as a
 * lightweight Desktop. Two copy-and-paste command blocks; the install one
 * carries the platform switch, since install.sh and install.ps1 differ.
 */
export function CliSection() {
  const { t } = useLocale();
  const d = t.download.cli;

  return (
    <section
      id="cli"
      className="mx-auto flex max-w-[880px] flex-col gap-5 px-5 pb-16 sm:px-8"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[24px] font-semibold sm:text-[28px]">{d.title}</h2>
        <p className="text-[#666]">{d.sub}</p>
      </div>

      <div className="flex flex-col gap-4 rounded-(--landing-radius-panel) bg-white p-[22px] sm:p-6">
        <div className="flex flex-col gap-1.5">
          <CommandLabel>{d.installLabel}</CommandLabel>
          <CliInstallCommand
            labels={{
              group: d.platformGroup,
              macosLinux: d.platformMacosLinux,
              windows: d.platformWindows,
            }}
            classNames={PLATFORM_TABS}
          >
            {(cmd) => (
              <CommandRow
                cmd={cmd}
                copyLabel={d.copyLabel}
                copiedLabel={d.copiedLabel}
              />
            )}
          </CliInstallCommand>
        </div>
        <div className="flex flex-col gap-1.5">
          <CommandLabel>{d.startLabel}</CommandLabel>
          <CommandRow
            cmd={SETUP_CMD}
            copyLabel={d.copyLabel}
            copiedLabel={d.copiedLabel}
          />
        </div>
        <p className="text-[13px] text-[#888]">{d.sshNote}</p>
      </div>
    </section>
  );
}

function CommandLabel({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-[#888]">{children}</p>;
}

function CommandRow({
  cmd,
  copyLabel,
  copiedLabel,
}: {
  cmd: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (await copyText(cmd)) {
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-(--landing-radius-action) bg-[#f7f7f7] py-2.5 pl-4 pr-2.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[13px]">
        {cmd}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="h-8 shrink-0 rounded-full bg-white px-3.5 text-[13px] hover:bg-[#f2f2f2]"
      >
        {copied ? copiedLabel : copyLabel}
      </button>
    </div>
  );
}
