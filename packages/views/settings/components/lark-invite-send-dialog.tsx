"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import { Input } from "@marvis/ui/components/ui/input";
import { Label } from "@marvis/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@marvis/ui/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@marvis/ui/components/ui/tabs";
import { Textarea } from "@marvis/ui/components/ui/textarea";
import { cn } from "@marvis/ui/lib/utils";
import { api, errorCode } from "@marvis/core/api";
import { useAuthStore } from "@marvis/core/auth";
import { useCurrentWorkspace } from "@marvis/core/paths";
import { createSafeId } from "@marvis/core/utils";
import { larkChatListOptions, workspaceKeys } from "@marvis/core/workspace/queries";
import { ActorAvatar } from "../../common/actor-avatar";
import { useLocale, useT } from "../../i18n";
import {
  ACTOR_TYPE,
  LarkChatAvatar,
  isLarkInviteErrorCode,
  useLarkInviteErrorText,
} from "./lark-invite-shared";

const TARGET_TAB = {
  chat: "chat",
  user: "user",
} as const;

type TargetTab = (typeof TARGET_TAB)[keyof typeof TARGET_TAB];

const ROLE = {
  member: "member",
  admin: "admin",
} as const satisfies Record<string, MemberRole>;

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

// 邮箱查不到时服务端返回 404，附带的错误码；这两个码在芯片上展示原因，其他错误弹 toast。
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
const MS_PER_HOUR = 60 * 60 * 1000;

// 与服务端 larkInviteMaxTargets、larkInviteNoteMaxRunes、max_uses 的上限一致。
const MAX_TARGETS = 50;
const NOTE_MAX_LENGTH = 200;
const MAX_USES_LIMIT = 2_147_483_647;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type EmailChip =
  | { email: string; state: typeof CHIP_STATE.checking }
  | { email: string; state: typeof CHIP_STATE.found; user: LarkUserLookup }
  | { email: string; state: typeof CHIP_STATE.unavailable; code: LarkInviteErrorCode };

interface SendFailure {
  key: string;
  name: string;
  reason: string;
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
 * LarkInviteSendDialog 是发送飞书邀请卡片的弹窗：选群或输入邮箱，设置角色、有效期、
 * 人数上限和附言，右侧预览卡片。关闭后表单状态丢弃。
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
      <DialogContent className="sm:max-w-3xl">
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
  const locale = useLocale();
  const qc = useQueryClient();
  const errorText = useLarkInviteErrorText();
  const idPrefix = useId();
  const inviter = useAuthStore((s) => s.user);
  const workspace = useCurrentWorkspace();
  // 机器人加进新群后要能在下次打开弹窗时看到，全局 staleTime 是 Infinity，所以每次挂载都重新拉取。
  const chats = useQuery({ ...larkChatListOptions(wsId), refetchOnMount: "always" });

  const [tab, setTab] = useState<TargetTab>(TARGET_TAB.chat);
  const [chatQuery, setChatQuery] = useState("");
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [emailInvalid, setEmailInvalid] = useState(false);
  const [chips, setChips] = useState<EmailChip[]>([]);
  const [role, setRole] = useState<MemberRole>(ROLE.member);
  const [expiryHours, setExpiryHours] = useState<number>(DEFAULT_EXPIRY_HOURS);
  const [maxUsesInput, setMaxUsesInput] = useState("");
  const [note, setNote] = useState("");
  const [failures, setFailures] = useState<SendFailure[]>([]);
  // 表单随弹窗打开挂载、关闭卸载，所以每次打开弹窗生成一个幂等键，这次打开里的每次提交都带上它：
  // 请求超时后再点一次，已经发出的接收方不会收到第二张卡片。
  const [idempotencyKey] = useState(createSafeId);

  const isChatTab = tab === TARGET_TAB.chat;
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
  const targetCount = isChatTab ? selectedChatIds.length : foundEmails.length;
  const overLimit = targetCount > MAX_TARGETS;
  const canSend =
    targetCount > 0 &&
    !overLimit &&
    !busy &&
    !hasPendingLookup &&
    !(isChatTab && !maxUses.valid);

  const roleItems = [
    { value: ROLE.member, label: t(($) => $.members.roles.member.label) },
    { value: ROLE.admin, label: t(($) => $.members.roles.admin.label) },
  ];
  const expiryItems = [
    { value: String(EXPIRY_HOURS.day), label: t(($) => $.members.lark.expiry_1d) },
    { value: String(EXPIRY_HOURS.week), label: t(($) => $.members.expiry_7d) },
    { value: String(EXPIRY_HOURS.month), label: t(($) => $.members.expiry_30d) },
  ];

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

      // 其他错误不是邮箱本身的问题：撤掉占位芯片，把邮箱放回输入框方便重试。
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

  const buildFailures = (results: LarkInviteSendResult[]): SendFailure[] => {
    const chatNames = new Map(chatList.map((chat) => [chat.chat_id, chat.name]));

    return results.map((result, index) => ({
      key: `${result.target.id}-${index}`,
      // 解析接收方失败时服务端不带名字，群按群列表补上，个人显示邮箱。
      name: result.target.name || chatNames.get(result.target.id) || result.target.id,
      reason: errorText(result.error?.code),
    }));
  };

  const handleSend = async () => {
    if (!canSend) return;

    onBusyChange(true);
    setFailures([]);

    const trimmedNote = note.trim();
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

      if (sent.length > 0) {
        toast.success(t(($) => $.members.lark.sent_toast, { count: sent.length }));
      }

      if (failed.length === 0) {
        onClose();
        return;
      }

      // 已发送的接收方从选择里去掉，重试只发失败的。
      const sentIds = new Set(sent.map((result) => result.target.id));
      setSelectedChatIds((current) => current.filter((id) => !sentIds.has(id)));
      setChips((current) => current.filter((chip) => !sentIds.has(chip.email)));
      setFailures(buildFailures(failed));
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

  const chipHints = chips.flatMap((chip) =>
    chip.state === CHIP_STATE.unavailable ? [chip] : [],
  );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(($) => $.members.lark.dialog_title)}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-4">
          <Tabs value={tab} onValueChange={handleTabChange}>
            <TabsList>
              <TabsTrigger value={TARGET_TAB.chat}>{t(($) => $.members.lark.tab_chat)}</TabsTrigger>
              <TabsTrigger value={TARGET_TAB.user}>{t(($) => $.members.lark.tab_user)}</TabsTrigger>
            </TabsList>

            <TabsContent value={TARGET_TAB.chat} className="space-y-2">
              <div className="relative">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={chatQuery}
                  onChange={(event) => setChatQuery(event.target.value)}
                  placeholder={t(($) => $.members.lark.search_chat)}
                  aria-label={t(($) => $.members.lark.search_chat)}
                  className="pl-8"
                />
              </div>
              <ChatList
                idPrefix={idPrefix}
                loading={chats.isPending}
                failed={chats.isError}
                failedText={chatsErrorText}
                chats={visibleChats}
                selectedIds={selectedChatIds}
                onToggle={toggleChat}
              />
              <p className="text-caption text-muted-foreground">
                {t(($) => $.members.lark.chat_hint)}
              </p>
            </TabsContent>

            <TabsContent value={TARGET_TAB.user} className="space-y-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${idPrefix}-email`}>{t(($) => $.members.lark.email_label)}</Label>
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
                />
                {emailInvalid ? (
                  <p className="text-caption text-destructive">
                    {t(($) => $.members.lark.email_invalid)}
                  </p>
                ) : null}
              </div>
              {chips.length > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {chips.map((chip) => (
                    <EmailChipItem
                      key={chip.email}
                      chip={chip}
                      onRemove={() => removeChip(chip.email)}
                    />
                  ))}
                </ul>
              ) : null}
              {chipHints.map((chip) => (
                <p key={chip.email} className="text-caption text-destructive">
                  {chip.code === ERROR_USER_NOT_FOUND
                    ? t(($) => $.members.lark.email_not_found, { email: chip.email })
                    : errorText(chip.code)}
                </p>
              ))}
              <p className="text-caption text-muted-foreground">
                {t(($) => $.members.lark.user_hint)}
              </p>
            </TabsContent>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-role`}>{t(($) => $.members.lark.role_label)}</Label>
              <Select
                items={roleItems}
                value={role}
                onValueChange={(value) => {
                  if (value === ROLE.member || value === ROLE.admin) setRole(value);
                }}
              >
                <SelectTrigger id={`${idPrefix}-role`} className="w-full">
                  <SelectValue>
                    {() => roleItems.find((item) => item.value === role)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {roleItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-expiry`}>{t(($) => $.members.lark.expiry_label)}</Label>
              <Select
                items={expiryItems}
                value={String(expiryHours)}
                onValueChange={(value) => {
                  const hours = Number(value);
                  if (Number.isFinite(hours) && hours > 0) setExpiryHours(hours);
                }}
              >
                <SelectTrigger id={`${idPrefix}-expiry`} className="w-full">
                  <SelectValue>
                    {() =>
                      expiryItems.find((item) => item.value === String(expiryHours))?.label
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {expiryItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {isChatTab ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={`${idPrefix}-max-uses`}>
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
                />
              </div>
            ) : null}

            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`${idPrefix}-note`}>{t(($) => $.members.lark.note_label)}</Label>
              <Textarea
                id={`${idPrefix}-note`}
                rows={2}
                maxLength={NOTE_MAX_LENGTH}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t(($) => $.members.lark.note_placeholder)}
              />
            </div>
          </div>

          {overLimit ? (
            <p className="text-caption text-destructive">
              {t(($) => $.members.lark.target_limit, { max: MAX_TARGETS })}
            </p>
          ) : null}

          {failures.length > 0 ? (
            <div role="alert" className="space-y-1.5 rounded-lg bg-destructive/10 px-3 py-2.5">
              <p className="text-label font-medium text-destructive">
                {t(($) => $.members.lark.failed_title)}
              </p>
              <ul className="space-y-1">
                {failures.map((failure) => (
                  <li key={failure.key} className="flex min-w-0 flex-wrap gap-x-2 text-caption">
                    <span className="min-w-0 truncate font-medium">{failure.name}</span>
                    <span className="text-muted-foreground">{failure.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <CardPreview
          inviterName={inviter?.name ?? ""}
          workspaceName={workspace?.name ?? ""}
          note={note.trim()}
          role={role}
          expiryHours={expiryHours}
          locale={locale}
        />
      </div>

      <DialogFooter className="sm:items-center sm:justify-between">
        <span className="text-caption text-muted-foreground">
          {t(($) => $.members.lark.sender_hint)}
        </span>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t(($) => $.members.confirm_cancel)}
          </Button>
          <Button
            type="button"
            disabled={!canSend}
            aria-busy={busy || undefined}
            onClick={() => void handleSend()}
          >
            {busy
              ? t(($) => $.members.lark.sending)
              : isChatTab
                ? t(($) => $.members.lark.send_to_chats, { count: targetCount })
                : t(($) => $.members.lark.send_to_users, { count: targetCount })}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function ChatList({
  idPrefix,
  loading,
  failed,
  failedText,
  chats,
  selectedIds,
  onToggle,
}: {
  idPrefix: string;
  loading: boolean;
  failed: boolean;
  /** 失败时显示的错误文案；为 null 时用通用的“加载失败”。 */
  failedText: string | null;
  chats: LarkChat[];
  selectedIds: string[];
  onToggle: (chatId: string, checked: boolean) => void;
}) {
  const { t } = useT("settings");

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-surface-border py-10 text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
      </div>
    );
  }

  if (failed || chats.length === 0) {
    return (
      <div className="rounded-lg border border-surface-border px-3 py-10 text-center text-body text-muted-foreground">
        {failed
          ? (failedText ?? t(($) => $.members.lark.chats_load_failed))
          : t(($) => $.members.lark.chats_empty)}
      </div>
    );
  }

  return (
    <div className="max-h-56 divide-y divide-surface-border overflow-y-auto rounded-lg border border-surface-border">
      {chats.map((chat) => {
        const selected = selectedIds.includes(chat.chat_id);
        const inputId = `${idPrefix}-chat-${chat.chat_id}`;

        return (
          <label
            key={chat.chat_id}
            htmlFor={inputId}
            // 选中的行悬停时保持选中底色，未选中的行悬停才变色。
            className={cn(
              "flex cursor-pointer items-center gap-3 px-3 py-2",
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

function EmailChipItem({ chip, onRemove }: { chip: EmailChip; onRemove: () => void }) {
  const { t } = useT("settings");
  const unavailable = chip.state === CHIP_STATE.unavailable;

  return (
    <li
      data-testid={`lark-email-chip-${chip.email}`}
      data-state={chip.state}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full py-1 pr-1.5 pl-2 text-label",
        unavailable
          ? "border border-destructive/40 bg-destructive/10 text-destructive"
          : "bg-field",
      )}
    >
      {chip.state === CHIP_STATE.found ? (
        <>
          <ActorAvatar
            actorType={ACTOR_TYPE.member}
            actorId={chip.user.open_id}
            name={chip.user.name}
            avatarUrl={chip.user.avatar_url}
            size="xs"
            profileLink={false}
          />
          <span className="min-w-0 truncate font-medium">{chip.user.name}</span>
          <span className="min-w-0 truncate text-muted-foreground">{chip.email}</span>
        </>
      ) : chip.state === CHIP_STATE.checking ? (
        <>
          <Loader2 aria-hidden="true" className="size-3 animate-spin text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">{chip.email}</span>
        </>
      ) : (
        <span className="min-w-0 truncate">{chip.email}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t(($) => $.members.lark.email_remove, { email: chip.email })}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/15"
      >
        <X aria-hidden="true" className="size-3" />
      </button>
    </li>
  );
}

/** 飞书卡片的静态预览，文案与服务端卡片一致，只随表单里的附言、角色和有效期变化。 */
function CardPreview({
  inviterName,
  workspaceName,
  note,
  role,
  expiryHours,
  locale,
}: {
  inviterName: string;
  workspaceName: string;
  note: string;
  role: MemberRole;
  expiryHours: number;
  locale: string;
}) {
  const { t } = useT("settings");
  const titleId = useId();

  const expiresOn = useMemo(
    () =>
      new Date(Date.now() + expiryHours * MS_PER_HOUR).toLocaleDateString(locale, {
        month: "long",
        day: "numeric",
      }),
    [expiryHours, locale],
  );

  return (
    <section aria-labelledby={titleId} className="hidden min-w-0 md:block">
      <p id={titleId} className="mb-2 text-caption text-muted-foreground">
        {t(($) => $.members.lark.preview)}
      </p>
      <div className="overflow-hidden rounded-xl border border-surface-border bg-surface text-label">
        <div className="bg-field px-3 py-2 text-body font-medium">
          {t(($) => $.members.lark.preview_title)}
        </div>
        <div className="space-y-2 px-3 py-3">
          <p>
            {t(($) => $.members.lark.preview_sentence, {
              inviter: inviterName,
              workspace: workspaceName,
            })}
          </p>
          {note !== "" ? (
            <p className="break-words text-muted-foreground">
              {t(($) => $.members.lark.preview_note, { note })}
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {t(($) => $.members.lark.preview_role, {
              role: t(($) => $.members.roles[role].label),
            })}
          </p>
          <p className="text-muted-foreground">
            {t(($) => $.members.lark.preview_expires, { date: expiresOn })}
          </p>
          <div className="rounded-lg bg-primary px-3 py-1.5 text-center font-medium text-primary-foreground">
            {t(($) => $.members.lark.preview_join)}
          </div>
        </div>
      </div>
    </section>
  );
}
