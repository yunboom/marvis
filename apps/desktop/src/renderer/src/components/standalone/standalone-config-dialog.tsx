import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@marvis/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { useT } from "@marvis/views/i18n";
import {
  INTEGRATION_KEY_ENVS,
  MIN_JWT_SECRET_LENGTH,
  randomHexSecret,
  randomIntegrationKey,
  validateStandaloneSetup,
  type IntegrationKeyEnv,
  type StandaloneConfigView,
  type StandaloneSecrets,
  type StandaloneSetupInput,
  type ValidationErrors,
} from "../../../../shared/standalone";
import { StandaloneSetupForm } from "./standalone-setup-form";

// 已锁定的密钥界面拿不到明文，只读框里显示掩码。
const LOCKED_MASK = "•".repeat(16);
// 本地校验时代替「不变」的值：主进程会用已保存的值，这里只要格式合法。
const KEPT_JWT = "k".repeat(MIN_JWT_SECRET_LENGTH);
const KEPT_INTEGRATION_KEY = `${"A".repeat(43)}=`;
const KEPT_SECRET = "kept";

function integrationKeys(make: () => string): Record<IntegrationKeyEnv, string> {
  const keys = {} as Record<IntegrationKeyEnv, string>;
  for (const env of INTEGRATION_KEY_ENVS) keys[env] = make();

  return keys;
}

// 编辑表单的初始值。已锁定时密钥显示掩码；未锁定（还没成功启动过）时与「完成设置」一样生成新密钥。
// 可选密钥留空表示不修改。
export function initialEditInput(config: StandaloneConfigView): StandaloneSetupInput {
  const { locked } = config;

  return {
    settings: config.settings,
    secrets: {
      jwtSecret: locked ? LOCKED_MASK : randomHexSecret(),
      integrationKeys: integrationKeys(locked ? () => LOCKED_MASK : randomIntegrationKey),
      loginCode: config.loginCode,
      postgresPassword: locked ? "" : randomHexSecret(),
      larkAppSecret: "",
      smtpPassword: "",
      llmApiKey: "",
    },
  };
}

// 提交给主进程的值：已锁定的密钥一律提交 ""，主进程合并时保留已保存的值。
export function editSubmission(value: StandaloneSetupInput, locked: boolean): StandaloneSetupInput {
  if (!locked) return value;

  return {
    settings: value.settings,
    secrets: { ...value.secrets, jwtSecret: "", integrationKeys: integrationKeys(() => ""), postgresPassword: "" },
  };
}

// 本地校验：把「不变」的密钥换成合法占位值，与主进程校验合并后的结果一致。
function validateEdit(value: StandaloneSetupInput, config: StandaloneConfigView): ValidationErrors {
  const { secrets } = value;
  const kept = (incoming: string, saved: boolean) => (incoming === "" && saved ? KEPT_SECRET : incoming);
  const preview: StandaloneSecrets = {
    ...secrets,
    jwtSecret: config.locked ? KEPT_JWT : secrets.jwtSecret,
    integrationKeys: config.locked ? integrationKeys(() => KEPT_INTEGRATION_KEY) : secrets.integrationKeys,
    larkAppSecret: kept(secrets.larkAppSecret, config.hasLarkAppSecret),
    smtpPassword: kept(secrets.smtpPassword, config.hasSmtpPassword),
    llmApiKey: kept(secrets.llmApiKey, config.hasLlmApiKey),
  };

  return validateStandaloneSetup({ settings: value.settings, secrets: preview });
}

export interface StandaloneConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  config: StandaloneConfigView;
  /** 保存成功后回调，用来刷新配置摘要。 */
  onSaved: () => void;
}

// 「配置 › 编辑」：复用「完成设置」的表单，保存后单机模式重新加载。
export function StandaloneConfigDialog({ open, onOpenChange, config, onSaved }: StandaloneConfigDialogProps) {
  const { t } = useT("settings");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-5 sm:max-w-140" showCloseButton={false}>
        {/* 每次打开都从当前配置重新开始，关闭时丢弃未保存的修改。 */}
        {open && (
          <ConfigEditor config={config} onSaved={onSaved} title={t(($) => $.desktop.standalone.settings.edit_title)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ConfigEditorProps {
  config: StandaloneConfigView;
  title: string;
  onSaved: () => void;
}

function ConfigEditor({ config, title, onSaved }: ConfigEditorProps) {
  const { t } = useT("settings");
  const [value, setValue] = useState(() => initialEditInput(config));
  const [serverErrors, setServerErrors] = useState<ValidationErrors>({});
  const [saving, setSaving] = useState(false);

  const errors = { ...validateEdit(value, config), ...serverErrors };
  const errorCount = Object.keys(errors).length;

  const handleChange = (next: StandaloneSetupInput) => {
    // 主进程返回的错误在用户改动后失效，之后以本地校验为准。
    setServerErrors({});
    setValue(next);
  };

  const handleSave = async () => {
    if (errorCount > 0 || saving) return;

    setSaving(true);

    try {
      const result = await window.desktopAPI.standalone.saveSettings(editSubmission(value, config.locked));
      if (!result.ok) {
        setServerErrors(result.errors);
        return;
      }

      onSaved();
    } catch {
      toast.error(t(($) => $.desktop.standalone.settings.save_failed));
    } finally {
      setSaving(false);
    }
  };

  const savedSecrets = {
    larkAppSecret: config.hasLarkAppSecret,
    smtpPassword: config.hasSmtpPassword,
    llmApiKey: config.hasLlmApiKey,
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t(($) => $.desktop.standalone.settings.edit_note)}</DialogDescription>
      </DialogHeader>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        <StandaloneSetupForm
          value={value}
          onChange={handleChange}
          errors={errors}
          locked={config.locked}
          savedSecrets={savedSecrets}
          showAllErrors={Object.keys(serverErrors).length > 0}
        />
      </div>

      <DialogFooter className="items-center">
        {errorCount > 0 && (
          <p role="status" className="mr-auto text-label text-destructive">
            {t(($) => $.desktop.standalone.setup.errors_count, { count: errorCount })}
          </p>
        )}
        <DialogClose render={<Button variant="outline" disabled={saving} />}>
          {t(($) => $.desktop.server.settings.cancel)}
        </DialogClose>
        <Button disabled={errorCount > 0 || saving} aria-busy={saving || undefined} onClick={() => void handleSave()}>
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {saving ? t(($) => $.desktop.standalone.settings.saving) : t(($) => $.desktop.standalone.settings.save)}
        </Button>
      </DialogFooter>
    </>
  );
}
