import { Loader2, WifiOff } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@marvis/ui/components/ui/alert-dialog";
import { Button } from "@marvis/ui/components/ui/button";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "@marvis/views/i18n";
import { SERVER_STATE_RECONNECTING } from "../../../../shared/server-discovery";
import type { BannerState, ServerLabel } from "./use-server-status";

interface ServerStatusBannerProps {
  state: BannerState;
  server: ServerLabel;
  onRetry: () => void;
  onSwitch: () => void;
}

// 主区白卡顶部的连接状态横幅：重连中显示转圈，不可达时给出“重试”和“切换服务器”。
export function ServerStatusBanner({ state, server, onRetry, onSwitch }: ServerStatusBannerProps) {
  const { t } = useT("settings");
  const reconnecting = state === SERVER_STATE_RECONNECTING;

  return (
    <div
      role="status"
      data-slot="server-status-banner"
      className={cn(
        "flex min-h-11 shrink-0 items-center gap-2.5 border-b border-border py-1.5 pr-3 pl-5 text-label",
        reconnecting
          ? "bg-warning/8 dark:bg-warning/10"
          : "bg-destructive/6 dark:bg-destructive/10",
      )}
    >
      {reconnecting ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <WifiOff className="size-4 shrink-0 text-destructive" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        {reconnecting
          ? t(($) => $.desktop.server.banner.reconnecting, { name: server.name })
          : t(($) => $.desktop.server.banner.unreachable, {
              name: server.name,
              address: server.address,
            })}
      </span>
      {!reconnecting && (
        <>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t(($) => $.desktop.server.banner.retry)}
          </Button>
          <Button type="button" size="sm" onClick={onSwitch}>
            {t(($) => $.desktop.server.banner.switch)}
          </Button>
        </>
      )}
    </div>
  );
}

interface ServerReplacedDialogProps {
  open: boolean;
  // 之前连接的服务器：名称和保存的地址。
  server: ServerLabel;
  // 现在在这个地址上应答的另一台服务器的名称。
  otherName: string;
  // “继续等待”：关闭弹窗，保持不切换。
  onWait: () => void;
  onSwitch: () => void;
}

// 保存的地址上换了一台服务器时的提示。不自动切换，由用户决定继续等待还是去切换。
export function ServerReplacedDialog({
  open,
  server,
  otherName,
  onWait,
  onSwitch,
}: ServerReplacedDialogProps) {
  const { t } = useT("settings");

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onWait();
      }}
    >
      <AlertDialogContent className="data-[size=default]:sm:max-w-110">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.desktop.server.replaced.title)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t(($) => $.desktop.server.replaced.body, {
              address: server.address,
              other: otherName,
              name: server.name,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="secondary">
            {t(($) => $.desktop.server.replaced.wait)}
          </AlertDialogCancel>
          <AlertDialogAction onClick={onSwitch}>
            {t(($) => $.desktop.server.replaced.switch)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
