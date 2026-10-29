import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@marvis/ui/components/ui/button";
import { Input } from "@marvis/ui/components/ui/input";
import { cn } from "@marvis/ui/lib/utils";
import { useT } from "@marvis/views/i18n";
import {
  normalizeServerAddress,
  type ProbeResult,
} from "../../../../shared/server-discovery";

/** 测试中状态的最短显示时长：本机探测只要几毫秒，状态一闪而过会像闪烁。 */
export const PROBE_MIN_DISPLAY_MS = 300;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 通过主进程探测地址。
export async function probeAddress(address: string): Promise<ProbeResult> {
  try {
    return await window.desktopAPI.server.probe(address);
  } catch {
    // 探测通道本身失败时，对用户而言等同于连不上这个地址。
    return { kind: "unreachable" };
  }
}

export interface ServerAddressFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 输入框为空时显示的示例地址。 */
  placeholder?: string;
  /** 当前地址的测试结果；没测过、测试中或地址被修改后为 null。 */
  result: ProbeResult | null;
  /** 测试连接有结果时回调；地址被修改时回调 null。重新测试期间保留上一次的结果。 */
  onResult: (result: ProbeResult | null) => void;
  /** 地址栏是否为当前选中的连接目标。 */
  selected?: boolean;
  /** 聚焦或点击地址栏时回调，用来把它设为选中项。 */
  onSelect?: () => void;
  /**
   * card：带标签和边框的选择卡片（连接页）；
   * plain：不带外框，标签只给辅助技术朗读，由页面自己的小标题承担（设置页）；
   * pane：放在连接页浅灰面板里的一行，选中时白底墨色描边，标签同样只给辅助技术。
   */
  variant?: "card" | "plain" | "pane";
  /** 排在“测试连接”之后的额外控件，与输入框同一行。 */
  actions?: ReactNode;
}

// 服务器地址输入框 + “测试连接”。测试结果就地显示，失败时结果行变红；
// card / plain 下输入框描边也变红，pane 下这一行已有选中描边，输入框保持中性描边，避免两层描边叠在一起。
// 测试中结果行换成同高的“正在测试”，按钮文字不变，避免高度、宽度和摘要来回跳。
// 结果由父组件持有，切到别的步骤再回来时仍然保留。
// 输入框、按钮和结果行都是可交互或需要被朗读的内容，所以外层用 group 而不是 radio
// （radio 的子树会被辅助技术当作展示用途剪掉）；选中状态用 aria-current 表达。
export function ServerAddressField({
  value,
  onChange,
  placeholder,
  result,
  onResult,
  selected = false,
  onSelect,
  variant = "card",
  actions,
}: ServerAddressFieldProps) {
  const { t } = useT("settings");
  const labelId = useId();
  const inputId = useId();
  const [testing, setTesting] = useState(false);
  // 每次测试或编辑都递增，用来丢弃已经过期的 probe 结果。
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  const handleChange = useCallback(
    (next: string) => {
      requestRef.current += 1;
      setTesting(false);
      onChange(next);
      onResult(null);
    },
    [onChange, onResult],
  );

  const handleTest = useCallback(async () => {
    requestRef.current += 1;
    const requestId = requestRef.current;

    onSelect?.();

    const address = normalizeServerAddress(value);
    if (address === null) {
      onResult({ kind: "unreachable" });
      return;
    }

    setTesting(true);

    const [probed] = await Promise.all([probeAddress(address), delay(PROBE_MIN_DISPLAY_MS)]);
    if (requestRef.current !== requestId) return;

    setTesting(false);
    onResult(probed);
  }, [onResult, onSelect, value]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (testing || value.trim() === "") return;
    void handleTest();
  };

  const failed = result !== null && result.kind !== "ok";
  const plain = variant === "plain";
  const pane = variant === "pane";

  return (
    <>
      <label
        id={labelId}
        htmlFor={inputId}
        className={cn(
          "text-label text-muted-foreground",
          plain || pane ? "sr-only" : "flex h-7 items-center",
        )}
      >
        {t(($) => $.desktop.server.address.label)}
      </label>
      <div
        role="group"
        aria-labelledby={labelId}
        aria-current={selected || undefined}
        onClick={onSelect}
        onFocus={onSelect}
        className={cn(
          "flex flex-col gap-2",
          variant === "card" && "mt-1.5 rounded-xl border p-2.5 transition-colors",
          variant === "card" && (selected ? "border-foreground bg-field" : "border-surface-border"),
          pane && "rounded-option py-2.5 pr-3.5 pl-2.5 transition-[background-color,box-shadow]",
          pane && selected && "bg-surface shadow-[0_0_0_1.5px_var(--color-foreground)]",
        )}
      >
        {/* 允许不带协议的输入（如 marvis.local:13840），交给 normalizeServerAddress 补全。 */}
        <form noValidate onSubmit={handleSubmit} className="flex items-center gap-2">
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={failed || undefined}
            placeholder={placeholder}
            value={value}
            onChange={(event) => handleChange(event.target.value)}
            className={cn(
              "h-10 flex-1 rounded-lg border px-3 text-body md:text-body",
              pane
                ? "border-transparent bg-surface ring-1 ring-surface-border hover:bg-surface focus-visible:bg-surface aria-invalid:border-transparent aria-invalid:ring-1 aria-invalid:ring-surface-border dark:aria-invalid:border-transparent dark:aria-invalid:ring-surface-border"
                : cn("font-mono", selected ? "border-input bg-background" : "border-transparent"),
            )}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={testing || value.trim() === ""}
            className={cn("h-10 shrink-0 px-3.5 text-label", pane && "bg-surface")}
          >
            {t(($) => $.desktop.server.address.test)}
          </Button>
          {actions}
        </form>
        {testing ? <ProbeTestingLine /> : result !== null && <ProbeResultLine result={result} />}
      </div>
    </>
  );
}

// 与结果行同样的排版，测试结束换成结果时高度不变。
function ProbeTestingLine() {
  const { t } = useT("settings");

  return (
    <p role="status" className="flex items-center gap-1.5 px-1 text-label text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
      <span>{t(($) => $.desktop.server.address.testing)}</span>
    </p>
  );
}

// 测试结果行：成功为绿色，失败为红色并给出原因。连接页的云服务选项也用它。
export function ProbeResultLine({ result }: { result: ProbeResult }) {
  const { t } = useT("settings");
  const ok = result.kind === "ok";

  let text: string;
  switch (result.kind) {
    case "ok":
      // 服务器没有报版本时不显示版本，避免末尾多出一个分隔符。
      text =
        result.server.version === ""
          ? t(($) => $.desktop.server.probe.ok_no_version, { name: result.server.name })
          : t(($) => $.desktop.server.probe.ok, {
              name: result.server.name,
              version: result.server.version,
            });
      break;
    case "not_marvis":
      text = t(($) => $.desktop.server.probe.not_marvis);
      break;
    case "too_old":
      text = t(($) => $.desktop.server.probe.too_old);
      break;
    default:
      text = t(($) => $.desktop.server.probe.unreachable);
  }

  return (
    <p
      role="status"
      className={cn(
        "flex items-center gap-1.5 px-1 text-label",
        ok ? "text-success" : "text-destructive",
      )}
    >
      {ok ? (
        <Check className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <X className="size-3.5 shrink-0" aria-hidden />
      )}
      <span>{text}</span>
    </p>
  );
}
