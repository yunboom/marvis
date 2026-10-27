import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

// Downloads run silently in the background (main process has
// autoDownload=true). The renderer only renders UI once the package is fully
// downloaded and waiting for a restart.
type UpdateState =
  | { status: "idle" }
  | { status: "ready"; version: string };

function changelogUrl(version: string): string {
  return `https://marvis.ai/changelog#release-${version.replace(/\./g, "-")}`;
}

export function UpdateNotification() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const cleanup = window.updater.onUpdateDownloaded((info) => {
      setState({ status: "ready", version: info.version });
      setDismissed(false);
    });
    return cleanup;
  }, []);

  if (state.status === "idle") return null;
  if (dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-xl border border-border bg-surface-raised p-4 shadow-toast animate-in slide-in-from-bottom-2 fade-in duration-(--motion-slow) ease-out">
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>

      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-success/10">
          <RefreshCw className="size-4 text-success" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-body font-medium">Update ready</p>
          <p className="text-caption text-muted-foreground mt-0.5">
            v{state.version} will be applied on next launch.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                window.desktopAPI.openExternal(changelogUrl(state.version))
              }
              className="inline-flex h-8 items-center rounded-full border border-input bg-background px-3.5 text-caption font-medium text-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-accent"
            >
              See changelog
            </button>
            <button
              type="button"
              onClick={() => window.updater.installUpdate()}
              className="inline-flex h-8 items-center rounded-full bg-primary px-3.5 text-caption font-medium text-primary-foreground transition-colors duration-(--motion-fast) ease-out hover:bg-primary/90"
            >
              Restart now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
