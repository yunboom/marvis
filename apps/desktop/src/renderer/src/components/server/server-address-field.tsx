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

export interface ServerAddressFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** 当前地址的测试结果；没测过、测试中或地址被修改后为 null。 */
  result: ProbeResult | null;
  /** 测试连接有结果时回调；地址被修改、测试开始时回调 null。 */
  onResult: (result: ProbeResult | null) => void;
  /** 地址栏是否为当前选中的连接目标。 */
  selected?: boolean;
  /** 聚焦或点击地址栏时回调，用来把它设为选中项。 */
  onSelect?: () => void;
  /**
   * card：带标签和边框的选择卡片（连接页）；
   * plain：不带外框，标签只给辅助技术朗读，由页面自己的小标题承担（设置页）。
   */
  variant?: "card" | "plain";
  /** 排在“测试连接”之后的额外控件，与输入框同一行。 */
  actions?: ReactNode;
}

// 服务器地址输入框 + “测试连接”。测试结果就地显示，失败时输入框描边变红。
// 结果由父组件持有，切到别的步骤再回来时仍然保留。
// 输入框、按钮和结果行都是可交互或需要被朗读的内容，所以外层用 group 而不是 radio
// （radio 的子树会被辅助技术当作展示用途剪掉）；选中状态用 aria-current 表达。
export function ServerAddressField({
  value,
  onChange,
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
    onResult(null);

    const address = normalizeServerAddress(value);
    if (address === null) {
      onResult({ kind: "unreachable" });
      return;
    }

    setTesting(true);

    let probed: ProbeResult;
    try {
      probed = await window.desktopAPI.server.probe(address);
    } catch {
      // 探测通道本身失败时，对用户而言等同于连不上这个地址。
      probed = { kind: "unreachable" };
    }
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

  return (
    <>
      <label
        id={labelId}
        htmlFor={inputId}
        className={cn(
          "text-label text-muted-foreground",
          plain ? "sr-only" : "flex h-7 items-center",
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
          !plain && "mt-1.5 rounded-xl border p-2.5 transition-colors",
          !plain && (selected ? "border-foreground bg-field" : "border-surface-border"),
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
            value={value}
            onChange={(event) => handleChange(event.target.value)}
            className={cn(
              "h-10 flex-1 rounded-lg border px-3 font-mono text-body md:text-body",
              selected ? "border-input bg-background" : "border-transparent",
            )}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={testing || value.trim() === ""}
            className="h-10 shrink-0 px-3.5 text-label"
          >
            {testing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {testing
              ? t(($) => $.desktop.server.address.testing)
              : t(($) => $.desktop.server.address.test)}
          </Button>
          {actions}
        </form>
        {result !== null && <ProbeResultLine result={result} />}
      </div>
    </>
  );
}

function ProbeResultLine({ result }: { result: ProbeResult }) {
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
