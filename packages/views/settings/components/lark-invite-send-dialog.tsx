"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import { toast } from "sonner";
import type {
  LarkChat,
  LarkInviteErrorCode,
  LarkInviteSendResult,
  LarkUserLookup,
  MemberRole,
} from "@marvis/core/types";
import { Button } from "@marvis/ui/components/ui/button";
import { Checkbox } from "@marvis/ui/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@marvis/ui/components/ui/dialog";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { api, errorCode } from "@marvis/core/api";
import { createSafeId } from "@marvis/core/utils";
import { larkChatListOptions, workspaceKeys } from "@marvis/core/workspace/queries";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import {
  ACTOR_TYPE,
  LarkChatAvatar,
  isLarkInviteErrorCode,
  useLarkInviteErrorText,
} from "./lark-invite-shared";
import { DIALOG_FULL_ON_NARROW, SegmentedRadio } from "./invite-controls";

const TARGET_TAB = {
  chat: "chat",
  user: "user",
} as const;

type TargetTab = (typeof TARGET_TAB)[keyof typeof TARGET_TAB];

const ROLE = {
  member: "member",
  admin: "admin",
} as const satisfies Record<string, MemberRole>;

type InviteRole = (typeof ROLE)[keyof typeof ROLE];

const SEND_STATUS = {
  sent: "sent",
  failed: "failed",
} as const satisfies Record<string, LarkInviteSendResult["status"]>;

// 邮箱查询的结果：查询中、查到、飞书侧不可用。
const CHIP_STATE = {
  checking: "checking",
  found: "found",
  unavailable: "unavailable",
} as const;

// 弹窗的两个阶段：编辑发送内容、查看发送结果（有接收方没发出去时才进入）。
const PHASE = {
  edit: "edit",
  result: "result",
} as const;

// 邮箱查不到时服务端返回 404，附带的错误码；这两个码在邮箱行上展示原因，其他错误弹 toast。
const CHIP_UNAVAILABLE_CODES: readonly LarkInviteErrorCode[] = [
  "user_not_found",
  "user_not_in_app_scope",
];
const ERROR_USER_NOT_FOUND: LarkInviteErrorCode = "user_not_found";

const HOURS_PER_DAY = 24;
const EXPIRY_DAYS = { day: 1, week: 7, month: 30 } as const;
const EXPIRY_HOURS = {
  day: EXPIRY_DAYS.day * HOURS_PER_DAY,
  week: EXPIRY_DAYS.week * HOURS_PER_DAY,
  month: EXPIRY_DAYS.month * HOURS_PER_DAY,
} as const;
const DEFAULT_EXPIRY_HOURS = EXPIRY_HOURS.week;

// 与服务端 larkInviteMaxTargets、larkInviteNoteMaxRunes、max_uses 的上限一致。
const MAX_TARGETS = 50;
const NOTE_MAX_LENGTH = 200;
const MAX_USES_LIMIT = 2_147_483_647;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 设置摘要里各项之间的分隔。
const SUMMARY_SEPARATOR = " · ";

type EmailChip =
  | { email: string; state: typeof CHIP_STATE.checking }
  | { email: string; state: typeof CHIP_STATE.found; user: LarkUserLookup }
  | { email: string; state: typeof CHIP_STATE.unavailable; code: LarkInviteErrorCode };

interface SendFailure {
  key: string;
  name: string;
  reason: string;
}

interface SendOutcome {
  sentNames: string[];
  failures: SendFailure[];
}

/** 人数上限输入框的取值：空表示不限（value 为 null），不是正整数或超出服务端上限时 valid 为 false。 */
function parseMaxUses(raw: string): { valid: boolean; value: number | null } {
  const text = raw.trim();
  if (text === "") return { valid: true, value: null };

  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_USES_LIMIT) {
    return { valid: false, value: null };
  }

  return { valid: true, value };
}

/**
 * LarkInviteSendDialog 是发送飞书邀请卡片的弹窗：选群或输入邮箱，邀请设置折叠成一行摘要，
 * 点开后设置角色、有效期、人数上限和附言。有接收方没发出去时切到结果页。关闭后表单状态丢弃。
 */
export function LarkInviteSendDialog({
  wsId,
  open,
  onOpenChange,
}: {
  wsId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // 发送中不允许关闭，否则失败列表无处显示。
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        className={cn(
          "flex flex-col gap-0 overflow-hidden p-0 sm:max-h-[min(47.5rem,calc(100dvh-2rem))] sm:max-w-xl",
          DIALOG_FULL_ON_NARROW,
        )}
      >
        <SendForm
          wsId={wsId}
          busy={busy}
          onBusyChange={setBusy}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SendForm({
  wsId,
  busy,
  onBusyChange,
  onClose,
}: {
  wsId: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useT("settings");
  const qc = useQueryClient();
  const errorText = useLarkInviteErrorText();
  const idPrefix = useId();
  // 机器人加进新群后要能在下次打开弹窗时看到，全局 staleTime 是 Infinity，所以每次挂载都重新拉取。
  const chats = useQuery({ ...larkChatListOptions(wsId), refetchOnMount: "always" });

  const [tab, setTab] = useState<TargetTab>(TARGET_TAB.chat);
  const [chatQuery, setChatQuery] = useState("");
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [role, setRole] = useState<InviteRole>(ROLE.member);
  const [expiryHours, setExpiryHours] = useState<number>(DEFAULT_EXPIRY_HOURS);
  const [maxUsesInput, setMaxUsesInput] = useState("");
  const [note, setNote] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  // 表单随弹窗打开挂载、关闭卸载，所以每次打开弹窗生成一个幂等键，这次打开里的每次提交都带上它：
  // 请求超时后再点一次，已经发出的接收方不会收到第二张卡片。
  const [idempotencyKey] = useState(createSafeId);

  const isChatTab = tab === TARGET_TAB.chat;
  const phase = outcome ? PHASE.result : PHASE.edit;
  const chatList = useMemo(() => chats.data ?? [], [chats.data]);
  // 列群失败时服务端带稳定错误码（如应用没开机器人的 lark_not_configured），按码显示本地化文案；
  // 没有可识别的错误码时用通用的“加载失败”。
  const chatsErrorCode = errorCode(chats.error);
  const chatsErrorText = isLarkInviteErrorCode(chatsErrorCode) ? errorText(chatsErrorCode) : null;
  const visibleChats = useMemo(() => {
    const needle = chatQuery.trim().toLocaleLowerCase();
    if (needle === "") return chatList;

    return chatList.filter((chat) => chat.name.toLocaleLowerCase().includes(needle));
  }, [chatList, chatQuery]);

  // 只有查到的邮箱才会发送，查不到的在提交时跳过。
  const foundEmails = chips.flatMap((chip) =>
    chip.state === CHIP_STATE.found ? [chip.email] : [],
  );
  const hasPendingLookup = chips.some((chip) => chip.state === CHIP_STATE.checking);
  const maxUses = parseMaxUses(maxUsesInput);
  const maxUsesBlocks = isChatTab && !maxUses.valid;
  const targetCount = isChatTab ? selectedChatIds.length : foundEmails.length;
  const overLimit = targetCount > MAX_TARGETS;
  const canSend = targetCount > 0 && !overLimit && !busy && !hasPendingLookup && !maxUsesBlocks;
  // 人数上限填错时设置区保持展开，让错误一直可见。
  const showSettings = settingsOpen || maxUsesBlocks;

  const roleItems = [
    { value: ROLE.member, label: t(($) => $.members.roles.member.label) },
    { value: ROLE.admin, label: t(($) => $.members.roles.admin.label) },
  ];
  const expiryItems = [
    { value: String(EXPIRY_HOURS.day), label: t(($) => $.members.lark.expiry_1d) },
    { value: String(EXPIRY_HOURS.week), label: t(($) => $.members.expiry_7d) },
    { value: String(EXPIRY_HOURS.month), label: t(($) => $.members.expiry_30d) },
  ];
  const trimmedNote = note.trim();
  const settingsSummary = [
    roleItems.find((item) => item.value === role)?.label ?? "",
    t(($) => $.members.lark.summary_expiry, {
      expiry: expiryItems.find((item) => item.value === String(expiryHours))?.label ?? "",
    }),
    ...(isChatTab
      ? [
          maxUses.value !== null
            ? t(($) => $.members.lark.summary_max_uses, { max: maxUses.value })
            : t(($) => $.members.lark.summary_unlimited),
        ]
      : []),
    ...(trimmedNote !== "" ? [t(($) => $.members.lark.summary_note)] : []),
  ].join(SUMMARY_SEPARATOR);

  const toggleChat = (chatId: string, checked: boolean) => {
    setSelectedChatIds((current) =>
      checked
        ? current.includes(chatId)
          ? current
          : [...current, chatId]
        : current.filter((id) => id !== chatId),
    );
  };

  const addEmail = async () => {
    const email = emailInput.trim().toLowerCase();
    if (email === "") return;

    if (!EMAIL_PATTERN.test(email)) {
      setEmailInvalid(true);
      return;
    }

    setEmailInvalid(false);
    setEmailInput("");
    if (chips.some((chip) => chip.email === email)) return;

    setChips((current) => [...current, { email, state: CHIP_STATE.checking }]);

    try {
      const user = await api.lookupLarkUser(wsId, email);
      setChips((current) =>
        current.map((chip) => (chip.email === email ? { email, state: CHIP_STATE.found, user } : chip)),
      );
    } catch (error) {
      const code = errorCode(error);
      if (isLarkInviteErrorCode(code) && CHIP_UNAVAILABLE_CODES.includes(code)) {
        setChips((current) =>
          current.map((chip) =>
            chip.email === email ? { email, state: CHIP_STATE.unavailable, code } : chip,
          ),
        );
        return;
      }

      // 其他错误不是邮箱本身的问题：撤掉占位行，把邮箱放回输入框方便重试。
      setChips((current) => current.filter((chip) => chip.email !== email));
      setEmailInput((current) => (current === "" ? email : current));
      toast.error(
        isLarkInviteErrorCode(code) ? errorText(code) : t(($) => $.members.lark.lookup_failed),
      );
    }
  };

  const handleEmailKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入法选词时的回车不算添加。
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;

    event.preventDefault();
    void addEmail();
  };

  const removeChip = (email: string) => {
    setChips((current) => current.filter((chip) => chip.email !== email));
  };

  const chatNames = useMemo(
    () => new Map(chatList.map((chat) => [chat.chat_id, chat.name])),
    [chatList],
  );
  // 解析接收方失败时服务端不带名字，群按群列表补上，个人显示邮箱。
  const targetName = (result: LarkInviteSendResult) =>
    result.target.name || chatNames.get(result.target.id) || result.target.id;

  const handleSend = async () => {
    if (!canSend) return;

    onBusyChange(true);

    const request = {
      ...(isChatTab ? { chat_ids: selectedChatIds } : { user_emails: foundEmails }),
      role,
      expires_in_hours: expiryHours,
      ...(isChatTab && maxUses.value !== null ? { max_uses: maxUses.value } : {}),
      ...(trimmedNote !== "" ? { note: trimmedNote } : {}),
      idempotency_key: idempotencyKey,
    };

    try {
      const results = await api.sendLarkInvites(wsId, request);
      const sent = results.filter((result) => result.status === SEND_STATUS.sent);
      const failed = results.filter((result) => result.status !== SEND_STATUS.sent);

      if (results.length === 0) {
        // 响应异常时无法确认结果，不能报“没有发送”，提示稍后刷新即可。
        toast.info(t(($) => $.members.lark.submitted_toast));
        onClose();
        return;
      }

      if (failed.length === 0) {
        toast.success(t(($) => $.members.lark.sent_toast, { count: sent.length }));
        onClose();
        return;
      }

      // 已发送的接收方从选择里去掉，返回修改后重试只发失败的。
      const sentIds = new Set(sent.map((result) => result.target.id));
      setSelectedChatIds((current) => current.filter((id) => !sentIds.has(id)));
      setChips((current) => current.filter((chip) => !sentIds.has(chip.email)));
      setOutcome({
        sentNames: sent.map(targetName),
        failures: failed.map((result, index) => ({
          key: `${result.target.id}-${index}`,
          name: targetName(result),
          reason: errorText(result.error?.code),
        })),
      });
    } catch (error) {
      const code = errorCode(error);
      toast.error(errorText(isLarkInviteErrorCode(code) ? code : undefined));
    } finally {
      // 发送可能已部分生效，不论结果都刷新列表。
      void qc.invalidateQueries({ queryKey: workspaceKeys.larkInvites(wsId) });
      onBusyChange(false);
    }
  };

  const handleTabChange = (value: unknown) => {
    if (value === TARGET_TAB.chat || value === TARGET_TAB.user) setTab(value);
  };

  const settingsPanelId = `${idPrefix}-settings`;

  return (
    <>
      <DialogHeader className="shrink-0 px-6 pt-5 pb-3">
        <DialogTitle>{t(($) => $.members.lark.dialog_title)}</DialogTitle>
      </DialogHeader>

      {phase === PHASE.result && outcome ? (
        <SendResult
          outcome={outcome}
          onBack={() => setOutcome(null)}
          onDone={onClose}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-6 pt-1 pb-4">
            <Tabs value={tab} onValueChange={handleTabChange} className="gap-3.5">
              <TabsList className="rounded-full">
                <TabsTrigger value={TARGET_TAB.chat} className="rounded-full px-4">
                  {t(($) => $.members.lark.tab_chat)}
                  <span className="text-caption font-normal tabular-nums text-faint-foreground">
                    {selectedChatIds.length}
                  </span>
                </TabsTrigger>
                <TabsTrigger value={TARGET_TAB.user} className="rounded-full px-4">
                  {t(($) => $.members.lark.tab_user)}
                  <span className="text-caption font-normal tabular-nums text-faint-foreground">
                    {foundEmails.length}
                  </span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value={TARGET_TAB.chat} className="space-y-2.5">
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    type="search"
                    value={chatQuery}
                    onChange={(event) => setChatQuery(event.target.value)}
                    placeholder={t(($) => $.members.lark.search_chat)}
                    aria-label={t(($) => $.members.lark.search_chat)}
                    className="pl-9"
                  />
                </div>
                <ChatList
                  idPrefix={idPrefix}
                  loading={chats.isPending}
                  failed={chats.isError}
                  failedText={chatsErrorText}
                  chats={visibleChats}
                  filtered={chatList.length > 0}
                  selectedIds={selectedChatIds}
                  onToggle={toggleChat}
                />
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.members.lark.chat_hint)}
                </p>
              </TabsContent>

              <TabsContent value={TARGET_TAB.user} className="space-y-2.5">
                <div className="space-y-1.5">
                  <Label htmlFor={`${idPrefix}-email`}>{t(($) => $.members.lark.email_label)}</Label>
                  <div className="flex gap-2">
                    <Input
                      id={`${idPrefix}-email`}
                      type="email"
                      autoComplete="off"
                      spellCheck={false}
                      value={emailInput}
                      onChange={(event) => {
                        setEmailInput(event.target.value);
                        setEmailInvalid(false);
                      }}
                      onKeyDown={handleEmailKeyDown}
                      placeholder={t(($) => $.members.lark.email_placeholder)}
                      aria-invalid={emailInvalid || undefined}
                      className="min-w-0 flex-1"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={emailInput.trim() === ""}
                      onClick={() => void addEmail()}
                    >
                      {t(($) => $.members.lark.email_add)}
                    </Button>
                  </div>
                  {emailInvalid ? (
                    <p className="text-caption text-destructive">
                      {t(($) => $.members.lark.email_invalid)}
                    </p>
                  ) : null}
                </div>
                {chips.length > 0 ? (
                  <ul className="space-y-1.5">
                    {chips.map((chip) => (
                      <EmailRow key={chip.email} chip={chip} onRemove={() => removeChip(chip.email)} />
                    ))}
                  </ul>
                ) : null}
                <p className="text-caption text-muted-foreground">
                  {t(($) => $.members.lark.user_hint)}
                </p>
              </TabsContent>
            </Tabs>

            <div className="rounded-option bg-surface-sunken">
              <button
                type="button"
                aria-expanded={showSettings}
                aria-controls={settingsPanelId}
                onClick={() => setSettingsOpen(!showSettings)}
                className="flex w-full items-center justify-between gap-2 rounded-option px-3.5 py-3 text-left focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-body font-medium">{t(($) => $.members.lark.settings_title)}</span>
                  <span className="truncate text-caption text-muted-foreground">{settingsSummary}</span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform duration-(--motion-fast)",
                    showSettings && "rotate-180",
                  )}
                />
              </button>
              {showSettings ? (
                <div id={settingsPanelId} className="space-y-3 px-3.5 pb-3.5">
                  <div className="space-y-1.5">
                    <p className="text-caption text-muted-foreground">{t(($) => $.members.lark.role_label)}</p>
                    <SegmentedRadio
                      label={t(($) => $.members.lark.role_label)}
                      options={roleItems}
                      value={role}
                      onChange={setRole}
                      className="bg-field-hover"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-caption text-muted-foreground">{t(($) => $.members.lark.expiry_label)}</p>
                    <SegmentedRadio
                      label={t(($) => $.members.lark.expiry_label)}
                      options={expiryItems}
                      value={String(expiryHours)}
                      onChange={(value) => setExpiryHours(Number(value))}
                      className="bg-field-hover"
                    />
                  </div>
                  {isChatTab ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`${idPrefix}-max-uses`} className="text-caption font-normal text-muted-foreground">
                        {t(($) => $.members.lark.max_uses_label)}
                      </Label>
                      <Input
                        id={`${idPrefix}-max-uses`}
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={maxUsesInput}
                        onChange={(event) => setMaxUsesInput(event.target.value)}
                        placeholder={t(($) => $.members.lark.max_uses_placeholder)}
                        aria-invalid={!maxUses.valid || undefined}
                        className="bg-surface"
                      />
                    </div>
                  ) : null}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={`${idPrefix}-note`} className="text-caption font-normal text-muted-foreground">
                        {t(($) => $.members.lark.note_label)}
                      </Label>
                      <span aria-hidden="true" className="text-caption tabular-nums text-faint-foreground">
                        {t(($) => $.members.lark.note_count, {
                          length: note.length,
                          max: NOTE_MAX_LENGTH,
                        })}
                      </span>
                    </div>
                    <Textarea
                      id={`${idPrefix}-note`}
                      rows={2}
                      maxLength={NOTE_MAX_LENGTH}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder={t(($) => $.members.lark.note_placeholder)}
                      className="resize-none bg-surface"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {overLimit ? (
              <p className="text-caption text-destructive">
                {t(($) => $.members.lark.target_limit, { max: MAX_TARGETS })}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-surface-border px-6 py-3.5">
            <span className="text-caption text-muted-foreground">
              {t(($) => $.members.lark.sender_hint)}
            </span>
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                {t(($) => $.members.confirm_cancel)}
              </Button>
              <Button
                type="button"
                disabled={!canSend}
                aria-busy={busy || undefined}
                onClick={() => void handleSend()}
              >
                {busy ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                {busy
                  ? t(($) => $.members.lark.sending)
                  : isChatTab
                    ? t(($) => $.members.lark.send_to_chats, { count: targetCount })
                    : t(($) => $.members.lark.send_to_users, { count: targetCount })}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function SendResult({
  outcome,
  onBack,
  onDone,
}: {
  outcome: SendOutcome;
  onBack: () => void;
  onDone: () => void;
}) {
  const { t } = useT("settings");
  const separator = t(($) => $.layout.read_only.separator);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-6">
      {outcome.sentNames.length > 0 ? (
        <div className="flex items-start gap-3 rounded-option bg-identity-green px-4 py-3.5">
          <Check aria-hidden="true" className="mt-0.5 size-4.5 shrink-0 text-identity-green-foreground" />
          <div className="min-w-0">
            <p className="text-body font-semibold">
              {t(($) => $.members.lark.sent_toast, { count: outcome.sentNames.length })}
            </p>
            <p className="text-label break-words text-muted-foreground">
              {outcome.sentNames.join(separator)}
            </p>
          </div>
        </div>
      ) : null}

      <div role="alert" className="space-y-2">
        <p className="text-label text-muted-foreground">
          {t(($) => $.members.lark.failed_count, { count: outcome.failures.length })}
        </p>
        <ul className="space-y-1.5">
          {outcome.failures.map((failure) => (
            <li
              key={failure.key}
              className="flex items-center gap-3 rounded-option bg-destructive/10 px-3.5 py-3"
            >
              <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-body font-medium">{failure.name}</span>
                <span className="text-label text-destructive">{failure.reason}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto flex justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onBack}>
          {t(($) => $.members.lark.back_to_edit)}
        </Button>
        <Button onClick={onDone}>{t(($) => $.members.done)}</Button>
      </div>
    </div>
  );
}

function ChatList({
  idPrefix,
  loading,
  failed,
  failedText,
  chats,
  filtered,
  selectedIds,
  onToggle,
}: {
  idPrefix: string;
  loading: boolean;
  failed: boolean;
  /** 失败时显示的错误文案；为 null 时用通用的“加载失败”。 */
  failedText: string | null;
  chats: LarkChat[];
  /** 群列表本身不空，只是被搜索词过滤空了。 */
  filtered: boolean;
  selectedIds: string[];
  onToggle: (chatId: string, checked: boolean) => void;
}) {
  const { t } = useT("settings");

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="flex items-center gap-2.5 rounded-option bg-destructive/10 px-4 py-3.5 text-body text-destructive">
        <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
        {failedText ?? t(($) => $.members.lark.chats_load_failed)}
      </div>
    );
  }

  if (chats.length === 0) {
    return (
      <div className="rounded-option border border-dashed border-surface-border px-3 py-8 text-center text-body text-muted-foreground">
        {filtered ? t(($) => $.members.lark.chats_no_match) : t(($) => $.members.lark.chats_empty)}
      </div>
    );
  }

  return (
    <div className="max-h-72 space-y-0.5 overflow-y-auto">
      {chats.map((chat) => {
        const selected = selectedIds.includes(chat.chat_id);
        const inputId = `${idPrefix}-chat-${chat.chat_id}`;

        return (
          <label
            key={chat.chat_id}
            htmlFor={inputId}
            // 选中的行悬停时保持选中底色，未选中的行悬停才变色。
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-option px-2.5 py-2",
              selected ? "bg-surface-selected" : "hover:bg-surface-hover",
            )}
          >
            <Checkbox
              id={inputId}
              checked={selected}
              onCheckedChange={(checked) => onToggle(chat.chat_id, checked === true)}
            />
            <LarkChatAvatar name={chat.name} avatarUrl={chat.avatar_url} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body">{chat.name}</span>
              <span className="block truncate text-caption text-muted-foreground">
                {chat.member_count > 0
                  ? t(($) => $.members.lark.chat_sub, { count: chat.member_count })
                  : t(($) => $.members.lark.chat_kind)}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function EmailRow({ chip, onRemove }: { chip: EmailChip; onRemove: () => void }) {
  const { t } = useT("settings");
  const errorText = useLarkInviteErrorText();
  const unavailable = chip.state === CHIP_STATE.unavailable;

  return (
    <li
      data-testid={`lark-email-chip-${chip.email}`}
      data-state={chip.state}
      className={cn(
        "flex items-center gap-3 rounded-option px-2.5 py-2",
        unavailable ? "bg-destructive/10" : "bg-surface-sunken",
      )}
    >
      {chip.state === CHIP_STATE.found ? (
        <ActorAvatar
          actorType={ACTOR_TYPE.member}
          actorId={chip.user.open_id}
          name={chip.user.name}
          avatarUrl={chip.user.avatar_url}
          size="lg"
          profileLink={false}
        />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-full text-label font-semibold",
            unavailable ? "bg-surface text-destructive" : "bg-field text-muted-foreground",
          )}
        >
          {chip.state === CHIP_STATE.checking ? <Loader2 className="size-3.5 animate-spin" /> : "@"}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium">
          {chip.state === CHIP_STATE.found ? chip.user.name : chip.email}
        </span>
        <span
          className={cn(
            "truncate text-caption",
            unavailable ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {chip.state === CHIP_STATE.found
            ? chip.email
            : chip.state === CHIP_STATE.checking
              ? t(($) => $.members.lark.email_checking)
              : chip.code === ERROR_USER_NOT_FOUND
                ? t(($) => $.members.lark.email_not_found)
                : errorText(chip.code)}
        </span>
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t(($) => $.members.lark.email_remove, { email: chip.email })}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </li>
  );
}
