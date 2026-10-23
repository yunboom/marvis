import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Dices, Info, TriangleAlert } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import { Switch } from "@marvis/ui/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@marvis/ui/components/ui/tooltip";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "@marvis/views/i18n";
import {
  INTEGRATION_KEY_ENVS,
  MAX_PORT,
  MIN_JWT_SECRET_LENGTH,
  MIN_PORT,
  VALIDATION_EMAIL,
  VALIDATION_JWT_LENGTH,
  VALIDATION_KEY_FORMAT,
  VALIDATION_LARK_APP_ID,
  VALIDATION_LARK_SECRET_REQUIRED,
  VALIDATION_LOGIN_CODE,
  VALIDATION_PORT_RANGE,
  VALIDATION_REQUIRED,
  VALIDATION_TENANT_KEYS,
  VALIDATION_URL,
  randomHexSecret,
  randomIntegrationKey,
  randomLoginCode,
  type IntegrationKeyEnv,
  type StandaloneSecrets,
  type StandaloneSettings,
  type StandaloneSetupInput,
  type ValidationCode,
  type ValidationErrors,
} from "../../../../shared/standalone";

// 表单字段在校验结果里的路径，与 validateStandaloneSetup 一致。
export const FIELD_ADMIN_EMAIL = "settings.adminEmail";
const FIELD_NAME = "settings.name";
const FIELD_PORT = "settings.port";
const FIELD_JWT = "secrets.jwtSecret";
const FIELD_LOGIN_CODE = "secrets.loginCode";
const FIELD_LARK_APP_ID = "settings.lark.appId";
const FIELD_LARK_SECRET = "secrets.larkAppSecret";
const FIELD_LARK_TENANTS = "settings.lark.tenantKeys";
const FIELD_SMTP_HOST = "settings.smtp.host";
const FIELD_SMTP_PORT = "settings.smtp.port";
const FIELD_SMTP_USERNAME = "settings.smtp.username";
const FIELD_SMTP_PASSWORD = "secrets.smtpPassword";
const FIELD_SMTP_FROM = "settings.smtp.fromEmail";
const FIELD_LLM_BASE_URL = "settings.llm.baseUrl";
const FIELD_LLM_API_KEY = "secrets.llmApiKey";
const FIELD_LLM_MODEL = "settings.llm.model";

function integrationKeyField(env: IntegrationKeyEnv): string {
  return `secrets.integrationKeys.${env}`;
}

const MIN_SMTP_PORT = 1;

// 「安全密钥」里直接显示的两个集成密钥，其余 5 个只在有错误时展开。
const SHOWN_KEY_ENVS: IntegrationKeyEnv[] = ["MARVIS_LARK_SECRET_KEY", "MARVIS_VCS_SECRET_KEY"];

const GROUP_GENERAL = "general";
const GROUP_KEYS = "keys";
const GROUP_CODE = "code";
const GROUP_LARK = "lark";
const GROUP_SMTP = "smtp";
const GROUP_LLM = "llm";

type GroupKey =
  | typeof GROUP_GENERAL
  | typeof GROUP_KEYS
  | typeof GROUP_CODE
  | typeof GROUP_LARK
  | typeof GROUP_SMTP
  | typeof GROUP_LLM;

const GROUP_FIELDS: Record<GroupKey, string[]> = {
  [GROUP_GENERAL]: [FIELD_NAME, FIELD_PORT],
  [GROUP_KEYS]: [FIELD_JWT, ...INTEGRATION_KEY_ENVS.map(integrationKeyField)],
  [GROUP_CODE]: [FIELD_LOGIN_CODE],
  [GROUP_LARK]: [FIELD_LARK_APP_ID, FIELD_LARK_SECRET, FIELD_LARK_TENANTS],
  [GROUP_SMTP]: [FIELD_SMTP_HOST, FIELD_SMTP_PORT, FIELD_SMTP_USERNAME, FIELD_SMTP_PASSWORD, FIELD_SMTP_FROM],
  [GROUP_LLM]: [FIELD_LLM_BASE_URL, FIELD_LLM_API_KEY, FIELD_LLM_MODEL],
};

// 局域网开着，却没有任何一种局域网成员能用的登录方式时提示。
export function needsLanLoginWarning({ settings }: StandaloneSetupInput): boolean {
  if (!settings.lanEnabled || settings.loginCodeEnabled) return false;

  return settings.lark.appId.trim() === "" && settings.smtp.host.trim() === "";
}

// 管理员邮箱没填时不立刻标红：失焦后或父组件要求时才显示「请填写」。
export function visibleSetupErrors(
  errors: ValidationErrors,
  showRequiredEmail: boolean,
): ValidationErrors {
  if (showRequiredEmail || errors[FIELD_ADMIN_EMAIL] !== VALIDATION_REQUIRED) return errors;

  const rest = { ...errors };
  delete rest[FIELD_ADMIN_EMAIL];

  return rest;
}

// 只保留数字；空串表示没有填。
function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

export interface StandaloneSetupFormProps {
  value: StandaloneSetupInput;
  onChange: (next: StandaloneSetupInput) => void;
  /** 本地校验与主进程返回的错误，键为字段路径。 */
  errors: ValidationErrors;
  /** 首次安装成功后，登录签名密钥和集成密钥只读。 */
  locked?: boolean;
  /** 已保存过的敏感值：输入框留空表示不修改。 */
  savedSecrets?: { larkAppSecret?: boolean; smtpPassword?: boolean; llmApiKey?: boolean };
  /** 为 true 时没填的管理员邮箱也立即显示错误（例如提交被拒后）。 */
  showAllErrors?: boolean;
}

// 单机模式的设置表单：必填的管理员邮箱展开显示，其余设置收在「默认配置」的折叠行里。
// 「完成设置」页和设置页的编辑弹窗共用。
export function StandaloneSetupForm({
  value,
  onChange,
  errors,
  locked = false,
  savedSecrets = {},
  showAllErrors = false,
}: StandaloneSetupFormProps) {
  const { t } = useT("settings");
  const message = useValidationMessage();
  const [emailTouched, setEmailTouched] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<GroupKey>>(() => new Set());
  const { settings, secrets } = value;

  const shown = visibleSetupErrors(errors, showAllErrors || emailTouched);
  const errorFor = (field: string, label: string): string | undefined => {
    const code = shown[field];

    return code ? message(code, label, field) : undefined;
  };

  const setSettings = (patch: Partial<StandaloneSettings>) =>
    onChange({ ...value, settings: { ...settings, ...patch } });
  const setSecrets = (patch: Partial<StandaloneSecrets>) =>
    onChange({ ...value, secrets: { ...secrets, ...patch } });
  const setIntegrationKey = (env: IntegrationKeyEnv, key: string) =>
    setSecrets({ integrationKeys: { ...secrets.integrationKeys, [env]: key } });

  const accessLabel = settings.lanEnabled
    ? t(($) => $.desktop.standalone.setup.access_lan)
    : t(($) => $.desktop.standalone.setup.access_local);
  const notConfigured = t(($) => $.desktop.standalone.form.not_configured);
  const keyHelp = t(($) => $.desktop.standalone.form.key_help);
  const keyLabels: Record<IntegrationKeyEnv, string> = {
    MARVIS_LARK_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.lark),
    MARVIS_VCS_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.vcs),
    MARVIS_SLACK_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.slack),
    MARVIS_DINGTALK_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.dingtalk),
    MARVIS_WECOM_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.wecom),
    MARVIS_TELEGRAM_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.telegram),
    MARVIS_PLUGIN_SECRET_KEY: t(($) => $.desktop.standalone.form.key_names.plugin),
  };
  const savedPlaceholder = t(($) => $.desktop.standalone.form.saved_secret);

  const keyField = (env: IntegrationKeyEnv) => (
    <TextField
      key={env}
      label={keyLabels[env]}
      help={keyHelp}
      value={secrets.integrationKeys[env] ?? ""}
      onChange={(next) => setIntegrationKey(env, next)}
      error={errorFor(integrationKeyField(env), keyLabels[env])}
      mono
      readOnly={locked}
      onRandom={locked ? undefined : () => setIntegrationKey(env, randomIntegrationKey())}
    />
  );
  const hiddenKeyEnvs = INTEGRATION_KEY_ENVS.filter((env) => !SHOWN_KEY_ENVS.includes(env));
  const hiddenKeysWithErrors = hiddenKeyEnvs.filter((env) => shown[integrationKeyField(env)] !== undefined);

  const llmConfigured =
    settings.llm.baseUrl.trim() !== "" || secrets.llmApiKey !== "" || savedSecrets.llmApiKey === true;
  let llmSummary = notConfigured;
  if (llmConfigured) {
    llmSummary = settings.llm.model.trim()
      ? t(($) => $.desktop.standalone.form.llm.summary_on, { model: settings.llm.model.trim() })
      : t(($) => $.desktop.standalone.form.configured);
  }

  const groups: { key: GroupKey; title: string; optional?: boolean; summary: string; body: ReactNode }[] = [
    {
      key: GROUP_GENERAL,
      title: t(($) => $.desktop.standalone.form.general.title),
      summary: t(($) => $.desktop.standalone.form.general.summary, {
        name: settings.name,
        port: Number.isNaN(settings.port) ? "" : settings.port,
        access: accessLabel,
      }),
      body: (
        <>
          <TextField
            label={t(($) => $.desktop.standalone.form.name.label)}
            help={t(($) => $.desktop.standalone.form.name.help)}
            value={settings.name}
            onChange={(name) => setSettings({ name })}
            error={errorFor(FIELD_NAME, t(($) => $.desktop.standalone.form.name.label))}
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.port.label)}
            help={t(($) => $.desktop.standalone.form.port.help)}
            value={Number.isNaN(settings.port) ? "" : String(settings.port)}
            onChange={(text) => {
              const digits = digitsOnly(text);
              setSettings({ port: digits === "" ? Number.NaN : Number(digits) });
            }}
            error={errorFor(FIELD_PORT, t(($) => $.desktop.standalone.form.port.label))}
            inputMode="numeric"
            mono
          />
          <SwitchField
            label={t(($) => $.desktop.standalone.form.lan.label)}
            help={t(($) => $.desktop.standalone.form.lan.help)}
            checked={settings.lanEnabled}
            onCheckedChange={(lanEnabled) => setSettings({ lanEnabled })}
          />
        </>
      ),
    },
    {
      key: GROUP_KEYS,
      title: t(($) => $.desktop.standalone.form.keys.title),
      summary: locked
        ? t(($) => $.desktop.standalone.form.keys.summary_locked)
        : t(($) => $.desktop.standalone.form.keys.summary),
      body: (
        <>
          <TextField
            label={t(($) => $.desktop.standalone.form.jwt.label)}
            help={t(($) => $.desktop.standalone.form.jwt.help)}
            value={secrets.jwtSecret}
            onChange={(jwtSecret) => setSecrets({ jwtSecret })}
            error={errorFor(FIELD_JWT, t(($) => $.desktop.standalone.form.jwt.label))}
            mono
            readOnly={locked}
            onRandom={locked ? undefined : () => setSecrets({ jwtSecret: randomHexSecret() })}
          />
          {SHOWN_KEY_ENVS.map(keyField)}
          {hiddenKeysWithErrors.map(keyField)}
          {hiddenKeysWithErrors.length === 0 && (
            <NoteField
              label={t(($) => $.desktop.standalone.form.other_keys.label)}
              help={t(($) => $.desktop.standalone.form.other_keys.help)}
            />
          )}
        </>
      ),
    },
    {
      key: GROUP_CODE,
      title: t(($) => $.desktop.standalone.form.login_code.title),
      summary: settings.loginCodeEnabled
        ? t(($) => $.desktop.standalone.form.login_code.summary_on, { code: secrets.loginCode })
        : t(($) => $.desktop.standalone.form.login_code.summary_off),
      body: (
        <>
          <SwitchField
            label={t(($) => $.desktop.standalone.form.login_code.switch_label)}
            help={t(($) => $.desktop.standalone.form.login_code.switch_help)}
            checked={settings.loginCodeEnabled}
            onCheckedChange={(loginCodeEnabled) => setSettings({ loginCodeEnabled })}
          />
          {settings.loginCodeEnabled && (
            <TextField
              label={t(($) => $.desktop.standalone.form.login_code.label)}
              help={t(($) => $.desktop.standalone.form.login_code.help)}
              value={secrets.loginCode}
              onChange={(text) => setSecrets({ loginCode: digitsOnly(text) })}
              error={errorFor(FIELD_LOGIN_CODE, t(($) => $.desktop.standalone.form.login_code.label))}
              placeholder={t(($) => $.desktop.standalone.form.login_code.placeholder)}
              inputMode="numeric"
              maxLength={6}
              mono
              onRandom={() => setSecrets({ loginCode: randomLoginCode() })}
            />
          )}
        </>
      ),
    },
    {
      key: GROUP_LARK,
      title: t(($) => $.desktop.standalone.form.lark.title),
      optional: true,
      summary: settings.lark.appId.trim()
        ? t(($) => $.desktop.standalone.form.lark.summary_on, { appId: settings.lark.appId.trim() })
        : notConfigured,
      body: (
        <>
          <TextField
            label={t(($) => $.desktop.standalone.form.lark.app_id_label)}
            help={t(($) => $.desktop.standalone.form.lark.app_id_help)}
            value={settings.lark.appId}
            onChange={(appId) => setSettings({ lark: { ...settings.lark, appId } })}
            error={errorFor(FIELD_LARK_APP_ID, t(($) => $.desktop.standalone.form.lark.app_id_label))}
            placeholder="cli_"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.lark.app_secret_label)}
            help={t(($) => $.desktop.standalone.form.lark.app_secret_help)}
            value={secrets.larkAppSecret}
            onChange={(larkAppSecret) => setSecrets({ larkAppSecret })}
            error={errorFor(FIELD_LARK_SECRET, t(($) => $.desktop.standalone.form.lark.app_secret_label))}
            placeholder={savedSecrets.larkAppSecret ? savedPlaceholder : undefined}
            type="password"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.lark.tenants_label)}
            help={t(($) => $.desktop.standalone.form.lark.tenants_help)}
            value={settings.lark.tenantKeys}
            onChange={(tenantKeys) => setSettings({ lark: { ...settings.lark, tenantKeys } })}
            error={errorFor(FIELD_LARK_TENANTS, t(($) => $.desktop.standalone.form.lark.tenants_label))}
            placeholder={t(($) => $.desktop.standalone.form.lark.tenants_placeholder)}
            mono
          />
        </>
      ),
    },
    {
      key: GROUP_SMTP,
      title: t(($) => $.desktop.standalone.form.smtp.title),
      optional: true,
      summary: settings.smtp.host.trim()
        ? t(($) => $.desktop.standalone.form.smtp.summary_on, { host: settings.smtp.host.trim() })
        : notConfigured,
      body: (
        <>
          <TextField
            label={t(($) => $.desktop.standalone.form.smtp.host_label)}
            help={t(($) => $.desktop.standalone.form.smtp.host_help)}
            value={settings.smtp.host}
            onChange={(host) => setSettings({ smtp: { ...settings.smtp, host } })}
            placeholder="smtp.example.com"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.smtp.port_label)}
            help={t(($) => $.desktop.standalone.form.smtp.port_help)}
            value={settings.smtp.port === null ? "" : String(settings.smtp.port)}
            onChange={(text) => {
              const digits = digitsOnly(text);
              setSettings({ smtp: { ...settings.smtp, port: digits === "" ? null : Number(digits) } });
            }}
            error={errorFor(FIELD_SMTP_PORT, t(($) => $.desktop.standalone.form.smtp.port_label))}
            inputMode="numeric"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.smtp.username_label)}
            help={t(($) => $.desktop.standalone.form.smtp.username_help)}
            value={settings.smtp.username}
            onChange={(username) => setSettings({ smtp: { ...settings.smtp, username } })}
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.smtp.password_label)}
            help={t(($) => $.desktop.standalone.form.smtp.password_help)}
            value={secrets.smtpPassword}
            onChange={(smtpPassword) => setSecrets({ smtpPassword })}
            placeholder={savedSecrets.smtpPassword ? savedPlaceholder : undefined}
            type="password"
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.smtp.from_label)}
            help={t(($) => $.desktop.standalone.form.smtp.from_help)}
            value={settings.smtp.fromEmail}
            onChange={(fromEmail) => setSettings({ smtp: { ...settings.smtp, fromEmail } })}
            type="email"
          />
        </>
      ),
    },
    {
      key: GROUP_LLM,
      title: t(($) => $.desktop.standalone.form.llm.title),
      optional: true,
      summary: llmSummary,
      body: (
        <>
          <TextField
            label={t(($) => $.desktop.standalone.form.llm.base_url_label)}
            help={t(($) => $.desktop.standalone.form.llm.base_url_help)}
            value={settings.llm.baseUrl}
            onChange={(baseUrl) => setSettings({ llm: { ...settings.llm, baseUrl } })}
            error={errorFor(FIELD_LLM_BASE_URL, t(($) => $.desktop.standalone.form.llm.base_url_label))}
            placeholder="https://api.openai.com/v1"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.llm.api_key_label)}
            help={t(($) => $.desktop.standalone.form.llm.api_key_help)}
            value={secrets.llmApiKey}
            onChange={(llmApiKey) => setSecrets({ llmApiKey })}
            placeholder={savedSecrets.llmApiKey ? savedPlaceholder : undefined}
            type="password"
            mono
          />
          <TextField
            label={t(($) => $.desktop.standalone.form.llm.model_label)}
            help={t(($) => $.desktop.standalone.form.llm.model_help)}
            value={settings.llm.model}
            onChange={(model) => setSettings({ llm: { ...settings.llm, model } })}
            mono
          />
        </>
      ),
    },
  ];

  const emailLabel = t(($) => $.desktop.standalone.form.admin_email.label);
  const groupErrorCount = (key: GroupKey) => GROUP_FIELDS[key].filter((field) => shown[field] !== undefined).length;
  const invalidGroups = groups.filter((group) => groupErrorCount(group.key) > 0).map((group) => group.key);
  const invalidGroupsKey = invalidGroups.join(",");

  // 有错误的分组自动展开，改好后保持展开，不让正在改的字段突然消失。
  useEffect(() => {
    if (invalidGroupsKey === "") return;

    setExpanded((current) => {
      const keys = invalidGroupsKey.split(",") as GroupKey[];
      if (keys.every((key) => current.has(key))) return current;

      return new Set([...current, ...keys]);
    });
  }, [invalidGroupsKey]);

  const toggleGroup = (key: GroupKey) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);

      return next;
    });

  return (
    <div className="flex flex-col gap-5">
      <TextField
        size="lg"
        label={emailLabel}
        help={t(($) => $.desktop.standalone.form.admin_email.help)}
        value={settings.adminEmail}
        onChange={(adminEmail) => setSettings({ adminEmail })}
        onBlur={() => setEmailTouched(true)}
        error={errorFor(FIELD_ADMIN_EMAIL, emailLabel)}
        placeholder={t(($) => $.desktop.standalone.form.admin_email.placeholder)}
        type="email"
      />

      <div className="flex flex-col gap-2">
        <h3 className="px-1 text-label font-semibold text-muted-foreground">
          {t(($) => $.desktop.standalone.form.defaults)}
        </h3>

        <div className="flex flex-col overflow-hidden rounded-2xl bg-surface ring-1 ring-surface-border">
          {groups.map((group) => {
            const errorCount = groupErrorCount(group.key);

            return (
              <SettingsGroup
                key={group.key}
                title={group.title}
                optional={group.optional}
                summary={
                  errorCount > 0
                    ? t(($) => $.desktop.standalone.form.needs_fix, { count: errorCount })
                    : group.summary
                }
                invalid={errorCount > 0}
                open={expanded.has(group.key) || errorCount > 0}
                onToggle={() => toggleGroup(group.key)}
              >
                {group.body}
              </SettingsGroup>
            );
          })}
        </div>

        {needsLanLoginWarning(value) && (
          <p role="note" className="mt-1 flex items-center gap-1.5 px-1 text-caption text-warning">
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {t(($) => $.desktop.standalone.form.lan_login_warning)}
          </p>
        )}
      </div>
    </div>
  );
}

// 校验错误码到界面文案。
export function useValidationMessage(): (code: ValidationCode, label: string, field: string) => string {
  const { t } = useT("settings");

  return (code, label, field) => {
    switch (code) {
      case VALIDATION_REQUIRED:
        return t(($) => $.desktop.standalone.form.validation.required, { label });
      case VALIDATION_EMAIL:
        return t(($) => $.desktop.standalone.form.validation.email);
      case VALIDATION_PORT_RANGE:
        return t(($) => $.desktop.standalone.form.validation.port_range, {
          min: field === FIELD_SMTP_PORT ? MIN_SMTP_PORT : MIN_PORT,
          max: MAX_PORT,
        });
      case VALIDATION_JWT_LENGTH:
        return t(($) => $.desktop.standalone.form.validation.jwt_length, { min: MIN_JWT_SECRET_LENGTH });
      case VALIDATION_KEY_FORMAT:
        return t(($) => $.desktop.standalone.form.validation.key_format);
      case VALIDATION_LOGIN_CODE:
        return t(($) => $.desktop.standalone.form.validation.login_code);
      case VALIDATION_LARK_APP_ID:
        return t(($) => $.desktop.standalone.form.validation.lark_app_id);
      case VALIDATION_LARK_SECRET_REQUIRED:
        return t(($) => $.desktop.standalone.form.validation.lark_secret_required);
      case VALIDATION_TENANT_KEYS:
        return t(($) => $.desktop.standalone.form.validation.tenant_keys);
      case VALIDATION_URL:
        return t(($) => $.desktop.standalone.form.validation.url);
    }
  };
}

interface SettingsGroupProps {
  title: string;
  optional?: boolean;
  summary: string;
  invalid: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}

// 「默认配置」里的一行：标题 + 当前值摘要，点开显示字段。
function SettingsGroup({ title, optional, summary, invalid, open, onToggle, children }: SettingsGroupProps) {
  const { t } = useT("settings");
  const bodyId = useId();

  return (
    <div className="flex flex-col border-t border-surface-border first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex min-h-12 items-center gap-2.5 py-1 pr-3.5 pl-4 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex w-30 shrink-0 items-baseline gap-1.5">
          <span className="text-body font-medium">{title}</span>
          {optional && (
            <span className="text-caption text-faint-foreground">
              {t(($) => $.desktop.standalone.form.optional)}
            </span>
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-label",
            invalid ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {summary}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-faint-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-3.5 px-4 pt-1 pb-4">
          {children}
        </div>
      )}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  help: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  error?: string;
  placeholder?: string;
  type?: "text" | "email" | "password";
  inputMode?: "numeric";
  maxLength?: number;
  mono?: boolean;
  readOnly?: boolean;
  /** 提供时在输入框右侧显示「随机」按钮。 */
  onRandom?: () => void;
  /** lg：展开显示的必填字段；md：折叠行里的字段。 */
  size?: "lg" | "md";
}

function TextField({
  label,
  help,
  value,
  onChange,
  onBlur,
  error,
  placeholder,
  type = "text",
  inputMode,
  maxLength,
  mono = false,
  readOnly = false,
  onRandom,
  size = "md",
}: TextFieldProps) {
  const { t } = useT("settings");
  const inputId = useId();
  const errorId = useId();
  const large = size === "lg";

  return (
    <div className={cn("flex flex-col", large ? "gap-2" : "gap-1.5")}>
      <FieldLabel htmlFor={inputId} label={label} help={help} large={large} />
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type={type}
          inputMode={inputMode}
          maxLength={maxLength}
          autoComplete="off"
          spellCheck={false}
          readOnly={readOnly}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "min-w-0 flex-1 truncate ring-1 ring-surface-border",
            large
              ? "h-11 rounded-xl bg-surface px-3.5 text-body-lg hover:bg-surface focus-visible:bg-surface md:text-body-lg"
              : "h-9.5 rounded-[10px] bg-surface-sunken px-3 hover:bg-surface-sunken focus-visible:bg-surface-sunken",
            mono && "font-mono text-label md:text-label",
            readOnly && "text-muted-foreground",
          )}
        />
        {onRandom && (
          <Button
            type="button"
            variant="outline"
            className="h-9.5 shrink-0 gap-1.5 px-3 text-label"
            aria-label={t(($) => $.desktop.standalone.form.random_label, { label })}
            onClick={onRandom}
          >
            <Dices className="size-3.5" aria-hidden />
            {t(($) => $.desktop.standalone.form.random)}
          </Button>
        )}
      </div>
      {error && (
        <p id={errorId} role="alert" className="px-1 text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface SwitchFieldProps {
  label: string;
  help: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

function SwitchField({ label, help, checked, onCheckedChange }: SwitchFieldProps) {
  const labelId = useId();

  return (
    <div className="flex items-center gap-1">
      <span id={labelId} className="text-label font-medium">
        {label}
      </span>
      <InfoTip label={label} help={help} />
      <Switch
        className="ml-auto"
        aria-labelledby={labelId}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next)}
      />
    </div>
  );
}

// 没有输入框的说明行（例如「其他 5 个集成密钥已随机生成」）。
function NoteField({ label, help }: { label: string; help: string }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-label text-muted-foreground">{label}</span>
      <InfoTip label={label} help={help} />
    </div>
  );
}

function FieldLabel({
  htmlFor,
  label,
  help,
  large,
}: {
  htmlFor: string;
  label: string;
  help: string;
  large: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <label htmlFor={htmlFor} className={cn(large ? "text-body font-semibold" : "text-label font-medium")}>
        {label}
      </label>
      <InfoTip label={label} help={help} />
    </div>
  );
}

const TOOLTIP_REASON_TRIGGER_PRESS = "trigger-press";
const TOOLTIP_REASON_OUTSIDE_PRESS = "outside-press";
const TOOLTIP_REASON_ESCAPE_KEY = "escape-key";

// 标签旁的「ⓘ」：悬停或聚焦时显示说明；点击后固定，再点一次、点别处或按 Esc 收起。
function InfoTip({ label, help }: { label: string; help: string }) {
  const { t } = useT("settings");
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);

  return (
    <Tooltip
      open={hovered || pinned}
      onOpenChange={(open, details) => {
        if (details.reason === TOOLTIP_REASON_TRIGGER_PRESS) return;
        if (details.reason === TOOLTIP_REASON_OUTSIDE_PRESS || details.reason === TOOLTIP_REASON_ESCAPE_KEY) {
          setPinned(false);
        }
        setHovered(open);
      }}
    >
      <TooltipTrigger
        closeOnClick={false}
        onClick={() => setPinned((current) => !current)}
        render={
          <button
            type="button"
            aria-label={t(($) => $.desktop.standalone.form.help, { label })}
            aria-expanded={pinned}
            className="inline-flex size-5.5 shrink-0 cursor-help items-center justify-center rounded-full text-faint-foreground outline-none transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Info className="size-3.5" aria-hidden />
          </button>
        }
      />
      <TooltipContent side="bottom" align="start" className="max-w-75 text-caption leading-relaxed font-normal">
        {help}
      </TooltipContent>
    </Tooltip>
  );
}
