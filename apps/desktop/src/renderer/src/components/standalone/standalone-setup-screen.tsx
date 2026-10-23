import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { MarvisIcon } from "@marvis/ui/components/common/marvis-icon";
import { Button } from "@marvis/ui/components/ui/button";
import {
  SplitCard,
  SplitCardActions,
  SplitCardIntro,
  SplitCardPane,
} from "@marvis/ui/components/common/split-card";
import { useT } from "@marvis/views/i18n";
import {
  validateStandaloneSetup,
  type StandaloneSetupInput,
  type ValidationErrors,
} from "../../../../shared/standalone";
import { StandaloneSetupForm } from "./standalone-setup-form";
import { StandaloneScreenFrame } from "./standalone-screen-frame";

const PRIMARY_BUTTON_CLASS = "h-12 w-full text-body-lg";

// 资源目录在各系统上的位置，只用于摘要展示（完整路径在设置页可以打开）。
export const DATA_LOCATION: Record<string, string> = {
  macos: "Application Support/Marvis",
  windows: "AppData\\Roaming\\Marvis",
  linux: ".config/Marvis",
};

export interface StandaloneSetupScreenProps {
  /** 上次填写的值；为 null 时从主进程读取预填值。 */
  value: StandaloneSetupInput | null;
  onChange: (next: StandaloneSetupInput) => void;
  onBack: () => void;
  /** 配置已保存、资源开始准备。 */
  onStarted: () => void;
}

// 「完成单机模式设置」：左栏摘要与按钮，右栏是设置表单。
export function StandaloneSetupScreen({ value, onChange, onBack, onStarted }: StandaloneSetupScreenProps) {
  const { t } = useT("settings");
  const [serverErrors, setServerErrors] = useState<ValidationErrors>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (value !== null) return;

    let cancelled = false;
    void window.desktopAPI.standalone.defaults().then((defaults) => {
      if (!cancelled) onChange(defaults);
    });

    return () => {
      cancelled = true;
    };
  }, [value, onChange]);

  const errors: ValidationErrors = value ? { ...validateStandaloneSetup(value), ...serverErrors } : {};
  const errorCount = Object.keys(errors).length;
  const blocked = value === null || errorCount > 0 || submitting;

  const handleChange = (next: StandaloneSetupInput) => {
    // 主进程返回的错误在用户改动后失效，之后以本地校验为准。
    setServerErrors({});
    onChange(next);
  };

  const handleSubmit = async () => {
    if (!value || blocked) return;

    setSubmitting(true);
    try {
      const result = await window.desktopAPI.standalone.install(value);
      if (result.ok) {
        onStarted();
        return;
      }
      setServerErrors(result.errors);
    } catch {
      toast.error(t(($) => $.desktop.standalone.setup.submit_failed));
    } finally {
      setSubmitting(false);
    }
  };

  const access = value?.settings.lanEnabled
    ? t(($) => $.desktop.standalone.setup.access_lan)
    : t(($) => $.desktop.standalone.setup.access_local);
  const location = DATA_LOCATION[window.desktopAPI.appInfo.os] ?? DATA_LOCATION.macos;

  return (
    <StandaloneScreenFrame>
      <SplitCard aria-label={t(($) => $.desktop.standalone.setup.title)} role="region">
        <SplitCardIntro>
          <MarvisIcon className="size-9 text-foreground" />

          <h1 className="mt-8 text-display-sm font-bold [@media(max-height:760px)]:mt-5">
            {t(($) => $.desktop.standalone.setup.title)}
          </h1>
          <p className="mt-3 text-body leading-relaxed text-muted-foreground">
            {t(($) => $.desktop.standalone.setup.subtitle)}
          </p>

          <dl className="mt-7 flex flex-col rounded-2xl bg-surface-sunken px-3.5 py-1 text-label [@media(max-height:760px)]:mt-5">
            <SummaryRow term={t(($) => $.desktop.standalone.setup.resources)}>
              {t(($) => $.desktop.standalone.setup.resources_size)}
            </SummaryRow>
            <SummaryRow term={t(($) => $.desktop.standalone.setup.location)}>
              <span className="truncate font-mono text-caption">{location}</span>
            </SummaryRow>
            <SummaryRow term={t(($) => $.desktop.standalone.setup.access)}>{access}</SummaryRow>
          </dl>
        </SplitCardIntro>

        <SplitCardPane>
          <div className="flex min-h-[320px] flex-1 flex-col overflow-y-auto rounded-[20px] bg-surface-sunken p-5 md:min-h-0">
            {value && (
              <StandaloneSetupForm
                value={value}
                onChange={handleChange}
                errors={errors}
                showAllErrors={Object.keys(serverErrors).length > 0}
              />
            )}
          </div>
        </SplitCardPane>

        <SplitCardActions className="gap-2">
          {errorCount > 0 && value && (
            <p role="status" className="mb-1 text-center text-label text-destructive">
              {t(($) => $.desktop.standalone.setup.errors_count, { count: errorCount })}
            </p>
          )}
          <Button
            size="lg"
            className={PRIMARY_BUTTON_CLASS}
            disabled={blocked}
            aria-busy={submitting || undefined}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {submitting
              ? t(($) => $.desktop.standalone.setup.submitting)
              : t(($) => $.desktop.standalone.setup.download)}
          </Button>
          <Button variant="ghost" size="lg" className="h-11 w-full text-body-lg" onClick={onBack}>
            {t(($) => $.desktop.standalone.setup.back)}
          </Button>
        </SplitCardActions>
      </SplitCard>
    </StandaloneScreenFrame>
  );
}

function SummaryRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center border-t border-surface-border first:border-t-0">
      <dt className="w-16 shrink-0 text-muted-foreground">{term}</dt>
      <dd className="flex min-w-0 items-center">{children}</dd>
    </div>
  );
}
