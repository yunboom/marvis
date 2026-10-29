"use client";

import { useId, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { toast } from "sonner";
import type { LarkInvite, LarkInviteStatus, LarkInviteTarget } from "@marvis/core/types";
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
import { api, errorCode } from "@marvis/core/api";
import {
  larkInviteListOptions,
  larkInviteStatusOptions,
  workspaceKeys,
} from "@marvis/core/workspace/queries";
import { ActorAvatar } from "../../common/actor-avatar";
import { useLocale, useT } from "../../i18n";
import {
  ACTOR_TYPE,
  INVITE_STATUS,
  LarkChatAvatar,
  effectiveInviteStatus,
  isLarkInviteErrorCode,
  useLarkInviteErrorText,
} from "./lark-invite-shared";
import { InviteEmptyState, RoleChip } from "./invite-controls";

// 接收方类型的取值，与服务端 JSON 一致。
const TARGET_TYPE = {
  chat: "chat",
  user: "user",
} as const satisfies Record<LarkInviteTarget["type"], LarkInviteTarget["type"]>;

// 通过界面发送的个人邀请，接收方 id 就是邮箱；CLI 传 open_id 时没有邮箱。
const TARGET_ID_TYPE_EMAIL = "email";

// 已加入的人最多叠放几个头像。
const MAX_JOINED_AVATARS = 5;

/** 有效的排在前面，其余按创建时间从新到旧。 */
function sortInvites(invites: LarkInvite[]): LarkInvite[] {
  const now = Date.now();
  const rank = (invite: LarkInvite) =>
    effectiveInviteStatus(invite, now) === INVITE_STATUS.active ? 0 : 1;
  const createdAt = (invite: LarkInvite) => Date.parse(invite.created_at) || 0;

  return [...invites].sort((a, b) => rank(a) - rank(b) || createdAt(b) - createdAt(a));
}

/**
 * LarkInvitesView 是成员页的“飞书邀请”视图：已发出的邀请卡片列表，可撤销有效的邀请。
 * 服务器没有配置飞书机器人时只显示未配置提示。onSend 给空列表提供发送入口。
 */
export function LarkInvitesView({ wsId, onSend }: { wsId: string; onSend?: () => void }) {
  const { t } = useT("settings");
  const status = useQuery(larkInviteStatusOptions());
  const configured = status.data?.enabled === true;
  const list = useQuery(larkInviteListOptions(wsId, configured));
  const invites = useMemo(() => sortInvites(list.data ?? []), [list.data]);

  if (status.data?.enabled === false) {
    return (
      <div className="rounded-lane bg-surface-sunken px-4 py-8 text-center">
        <p className="text-body font-medium text-foreground">
          {t(($) => $.members.lark.not_configured_title)}
        </p>
        <p className="mx-auto mt-1 max-w-md text-label text-muted-foreground">
          {t(($) => $.members.lark.not_configured_body)}
        </p>
      </div>
    );
  }

  if (!configured || list.isPending) return null;

  if (list.isError) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2.5 rounded-option bg-destructive/10 px-4 py-3.5 text-body text-destructive"
      >
        <AlertCircle aria-hidden="true" className="size-4 shrink-0" />
        {t(($) => $.members.lark.load_failed)}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-label text-muted-foreground">{t(($) => $.members.lark.intro)}</p>
      {invites.length === 0 ? (
        <InviteEmptyState
          action={
            onSend ? (
              <Button size="sm" onClick={onSend}>
                {t(($) => $.members.lark.send)}
              </Button>
            ) : undefined
          }
        >
          {t(($) => $.members.lark.empty)}
        </InviteEmptyState>
      ) : (
        <ul>
          {invites.map((invite) => (
            <InviteRow key={invite.id} wsId={wsId} invite={invite} />
          ))}
        </ul>
      )}
    </div>
  );
}

function InviteRow({ wsId, invite }: { wsId: string; invite: LarkInvite }) {
  const { t } = useT("settings");
  const locale = useLocale();
  const qc = useQueryClient();
  const errorText = useLarkInviteErrorText();
  const nameId = useId();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const { target } = invite;
  const status = effectiveInviteStatus(invite);
  const isActive = status === INVITE_STATUS.active;
  // 已过期、已撤销的邀请淡化显示，已完成的仍是正常的历史记录。
  const isDimmed = status === INVITE_STATUS.expired || status === INVITE_STATUS.revoked;
  const displayName = target.name || target.id;
  const sender = invite.sent_by_agent ?? invite.sent_by;

  const handleRevoke = async () => {
    setRevoking(true);

    try {
      await api.revokeLarkInvite(wsId, invite.id);
      toast.success(t(($) => $.members.lark.toast_revoked));
    } catch (error) {
      const code = errorCode(error);
      toast.error(
        isLarkInviteErrorCode(code) ? errorText(code) : t(($) => $.members.lark.toast_revoke_failed),
      );
    } finally {
      // 不依赖接口返回的邀请，一律重新拉取列表，以服务端状态为准。
      await qc.invalidateQueries({ queryKey: workspaceKeys.larkInvites(wsId) });
      setRevoking(false);
    }
  };

  return (
    <li
      data-status={status}
      className="flex items-center gap-3 border-b border-surface-border py-3 @max-xl:flex-wrap @max-xl:items-start @max-xl:gap-y-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className={cn("flex shrink-0", isDimmed && "opacity-60")}>
          <TargetAvatar target={target} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span
              id={nameId}
              className={cn("truncate text-body font-medium", isDimmed && "text-muted-foreground")}
            >
              {displayName}
            </span>
            <StatusChip status={status} />
          </div>
          <div className="truncate text-label text-muted-foreground">
            {target.type === TARGET_TYPE.user && target.id_type === TARGET_ID_TYPE_EMAIL
              ? t(($) => $.members.lark.user_sub, { email: target.id })
              : target.type === TARGET_TYPE.user
                ? t(($) => $.members.lark.user_kind)
                : t(($) => $.members.lark.chat_kind)}
          </div>
        </div>
      </div>
      <div
        className={cn(
          "flex shrink-0 items-center gap-3.5 text-label @max-xl:order-3 @max-xl:basis-full @max-xl:flex-wrap @max-xl:gap-x-2.5 @max-xl:gap-y-1 @max-xl:pl-11",
          // 失效的邀请用更浅的实色文字，不用透明度。
          isDimmed ? "text-faint-foreground" : "text-muted-foreground",
        )}
      >
        <JoinedCell invite={invite} />
        <RoleChip role={invite.role}>{t(($) => $.members.roles[invite.role].label)}</RoleChip>
        <span className="tabular-nums @max-xl:hidden">
          {t(($) => $.members.lark.expires_on, {
            date: new Date(invite.expires_at).toLocaleDateString(locale),
          })}
        </span>
        <span className="flex min-w-0 max-w-32 items-center gap-1.5 @max-xl:hidden">
          <ActorAvatar
            actorType={invite.sent_by_agent ? ACTOR_TYPE.agent : ACTOR_TYPE.member}
            actorId={sender.id}
            name={sender.name}
            avatarUrl={sender.avatar_url}
            size="sm"
            profileRequiresDirectoryEntry
          />
          <span className="min-w-0 truncate">{sender.name}</span>
        </span>
      </div>
      <span className="flex w-16 shrink-0 justify-end">
        {isActive ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={revoking}
            aria-busy={revoking || undefined}
            aria-describedby={nameId}
            onClick={() => setConfirmOpen(true)}
          >
            {t(($) => $.members.lark.revoke)}
          </Button>
        ) : null}
      </span>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.members.lark.revoke_title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.members.lark.revoke_description, { name: displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.members.confirm_cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void handleRevoke();
              }}
            >
              {t(($) => $.members.lark.revoke)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

/** 群用群头像，个人用成员头像；个人不一定是 Marvis 成员，所以不链接到成员页。 */
function TargetAvatar({ target }: { target: LarkInviteTarget }) {
  if (target.type === TARGET_TYPE.chat) {
    return <LarkChatAvatar name={target.name} avatarUrl={target.avatar_url} />;
  }

  return (
    <ActorAvatar
      actorType={ACTOR_TYPE.member}
      actorId={target.id}
      name={target.name || target.id}
      avatarUrl={target.avatar_url}
      size="lg"
      profileLink={false}
    />
  );
}

// 状态标签的配色：有效是绿色，已完成是蓝色，失效的两种是中性灰。
const STATUS_TONE: Record<LarkInviteStatus, { chip: string; dot: string }> = {
  active: {
    chip: "bg-identity-green text-identity-green-foreground",
    dot: "bg-identity-green-foreground",
  },
  completed: {
    chip: "bg-identity-blue text-identity-blue-foreground",
    dot: "bg-identity-blue-foreground",
  },
  expired: { chip: "bg-field text-muted-foreground", dot: "bg-faint-foreground" },
  revoked: { chip: "bg-field text-muted-foreground", dot: "bg-faint-foreground" },
};

function StatusChip({ status }: { status: LarkInviteStatus }) {
  const { t } = useT("settings");

  const label =
    status === INVITE_STATUS.active
      ? t(($) => $.members.lark.status_active)
      : status === INVITE_STATUS.completed
        ? t(($) => $.members.lark.status_completed)
        : status === INVITE_STATUS.expired
          ? t(($) => $.members.lark.status_expired)
          : t(($) => $.members.lark.status_revoked);
  const tone = STATUS_TONE[status];

  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-micro font-medium whitespace-nowrap",
        tone.chip,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", tone.dot)} />
      {label}
    </span>
  );
}

function JoinedCell({ invite }: { invite: LarkInvite }) {
  const { t } = useT("settings");
  const { target, joined, use_count: used, max_uses: max } = invite;

  const summary =
    target.type === TARGET_TYPE.user
      ? used > 0
        ? t(($) => $.members.lark.joined)
        : t(($) => $.members.lark.not_joined)
      : max !== null
        ? t(($) => $.members.lark.joined_of, { used, max })
        : used > 0
          ? t(($) => $.members.lark.joined_count, { count: used })
          : t(($) => $.members.lark.not_joined);

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {joined.length > 0 ? (
        <span className="flex shrink-0 -space-x-1.5">
          {joined.slice(0, MAX_JOINED_AVATARS).map((user) => (
            <ActorAvatar
              key={user.user_id}
              actorType={ACTOR_TYPE.member}
              actorId={user.user_id}
              name={user.name}
              avatarUrl={user.avatar_url}
              size="sm"
              profileRequiresDirectoryEntry
              className="ring-2 ring-background"
            />
          ))}
        </span>
      ) : null}
      <span className="min-w-0 truncate whitespace-nowrap">{summary}</span>
    </span>
  );
}
