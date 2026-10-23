import { useId, useState } from "react";
import { Laptop, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { useT } from "@marvis/views/i18n";
import { useLogoutBeforeSwitch } from "../server/use-logout-before-switch";
import { useStandaloneStatus } from "./use-standalone-status";

// 连接远程服务器时，「服务器」设置里的「这台电脑」：单机模式已安装才显示，确认后切回单机模式。
export function StandaloneDeviceRow() {
  const { t } = useT("settings");
  const nameId = useId();
  const status = useStandaloneStatus();
  const logoutBeforeSwitch = useLogoutBeforeSwitch();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [switching, setSwitching] = useState(false);

  if (status === null || status.version === null) return null;

  const handleOpenChange = (open: boolean) => {
    // 退出登录和切换进行中不允许关闭。
    if (!open && switching) return;
    setConfirmOpen(open);
  };

  const handleConfirm = async () => {
    setSwitching(true);

    try {
      await logoutBeforeSwitch();
      // 选定本机后主进程会重载所有窗口，并以管理员身份登录。
      await window.desktopAPI.standalone.enter();
    } catch {
      // 退出登录会卸载设置页，失败提示走全局 toast。
      toast.error(t(($) => $.desktop.standalone.prepare.enter_failed));
      setSwitching(false);
    }
  };

  return (
    <section
      aria-labelledby={nameId}
      className="flex min-h-14 items-center gap-3 rounded-xl px-4 py-2 ring-1 ring-surface-border"
    >
      <Laptop className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col gap-0.75">
        <span id={nameId} className="truncate text-body font-medium">
          {t(($) => $.desktop.standalone.settings.this_computer)}
        </span>
        <span className="truncate text-caption text-muted-foreground">
          {t(($) => $.desktop.standalone.settings.ready, { version: status.version })}
        </span>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-describedby={nameId}
        onClick={() => setConfirmOpen(true)}
        className="px-3.5"
      >
        {t(($) => $.desktop.server.settings.switch)}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={handleOpenChange}>
        <AlertDialogContent className="data-[size=default]:sm:max-w-105">
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.desktop.standalone.settings.enter_title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.desktop.standalone.settings.enter_body)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="secondary" disabled={switching}>
              {t(($) => $.desktop.server.settings.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction disabled={switching} onClick={() => void handleConfirm()}>
              {switching && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t(($) => $.desktop.server.settings.switch)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
