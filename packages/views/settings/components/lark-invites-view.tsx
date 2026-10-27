"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { LarkInvite, LarkInviteStatus, LarkInviteTarget } from "@marvis/core/types";
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
import { SettingsCard } from "./settings-layout";
import {
  ACTOR_TYPE,
  INVITE_STATUS,
  LarkChatAvatar,
  effectiveInviteStatus,
  isLarkInviteErrorCode,
  useLarkInviteErrorText,
} from "./lark-invite-shared";

// 接收方类型的取值，与服务端 JSON 一致。
const TARGET_TYPE = {
  chat: "chat",
  user: "user",
} as const satisfies Record<LarkInviteTarget["type"], LarkInviteTarget["type"]>;

// 通过界面发送的个人邀请，接收方 id 就是邮箱；CLI 传 open_id 时没有邮箱。
const TARGET_ID_TYPE_EMAIL = "email";

// 已加入的人最多叠放几个头像。
const MAX_JOINED_AVATARS = 5;

// 各列宽度，表头和每一行共用，保证对齐。
const COLUMN_ROLE = "w-20";
const COLUMN_JOINED = "w-44";
const COLUMN_EXPIRY = "w-24";
const COLUMN_SENDER = "w-32";
const COLUMN_ACTION = "w-14";

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
 * 服务器没有配置飞书机器人时只显示未配置提示。
 */
export function LarkInvitesView({ wsId }: { wsId: string }) {
  const { t } = useT("settings");
  const status = useQuery(larkInviteStatusOptions());
  const configured = status.data?.enabled === true;
  const list = useQuery(larkInviteListOptions(wsId, configured));
  const invites = useMemo(() => sortInvites(list.data ?? []), [list.data]);

  if (status.data?.enabled === false) {
    return (
      <EmptyPanel>
        <p className="text-body font-medium text-foreground">
          {t(($) => $.members.lark.not_configured_title)}
        </p>
        <p className="mx-auto mt-1 max-w-md text-label text-muted-foreground">
          {t(($) => $.members.lark.not_configured_body)}
        </p>
      </EmptyPanel>
    );
  }

  if (!configured || list.isPending) return null;

  if (list.isError) {
    return <EmptyPanel>{t(($) => $.members.lark.load_failed)}</EmptyPanel>;
  }

  return (
    <div className="space-y-3">
      <p className="text-label text-muted-foreground">{t(($) => $.members.lark.intro)}</p>
      {invites.length === 0 ? (
        <EmptyPanel>{t(($) => $.members.lark.empty)}</EmptyPanel>
      ) : (
        <>
          <ListHeader />
          <SettingsCard>
            <ul className="divide-y divide-surface-border">
              {invites.map((invite) => (
                <InviteRow key={invite.id} wsId={wsId} invite={invite} />
              ))}
            </ul>
          </SettingsCard>
        </>
      )}
    </div>
  );
}

function EmptyPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-surface-border px-4 py-10 text-center text-body text-muted-foreground">
      {children}
    </div>
  );
}

function ListHeader() {
  const { t } = useT("settings");

  return (
    <div
      aria-hidden="true"
      className="hidden items-center gap-3 px-4 text-caption text-muted-foreground lg:flex"
    >
      {/* 左侧留出头像和间距，让“接收方”对齐名字。 */}
      <span className="min-w-0 flex-1 pl-11">{t(($) => $.members.lark.col_target)}</span>
      <span className={cn("shrink-0", COLUMN_ROLE)}>{t(($) => $.members.lark.col_role)}</span>
      <span className={cn("shrink-0", COLUMN_JOINED)}>{t(($) => $.members.lark.col_joined)}</span>
      <span className={cn("shrink-0", COLUMN_EXPIRY)}>{t(($) => $.members.lark.col_expiry)}</span>
      <span className={cn("shrink-0", COLUMN_SENDER)}>{t(($) => $.members.lark.col_sender)}</span>
      <span className={cn("shrink-0", COLUMN_ACTION)} />
    </div>
  );
}

function InviteRow({ wsId, invite }: { wsId: string; invite: LarkInvite }) {
  const { t } = useT("settings");
  const locale = useLocale();
  const qc = useQueryClient();
  const errorText = useLarkInviteErrorText();
  const nameId = useId();
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
    <li data-status={status} className="flex items-center gap-3 px-4 py-3">
      <TargetAvatar target={target} dimmed={isDimmed} />
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
        <div className="truncate text-caption text-muted-foreground">
          {target.type === TARGET_TYPE.user && target.id_type === TARGET_ID_TYPE_EMAIL
            ? t(($) => $.members.lark.user_sub, { email: target.id })
            : target.type === TARGET_TYPE.user
              ? t(($) => $.members.lark.user_kind)
              : t(($) => $.members.lark.chat_kind)}
        </div>
      </div>
      <span
        className={cn(
          "hidden shrink-0 truncate text-body lg:block",
          COLUMN_ROLE,
          isDimmed && "text-muted-foreground",
        )}
      >
        {t(($) => $.members.roles[invite.role].label)}
      </span>
      <JoinedCell invite={invite} />
      <span
        className={cn(
          "hidden shrink-0 text-caption tabular-nums text-muted-foreground lg:block",
          COLUMN_EXPIRY,
        )}
      >
        {new Date(invite.expires_at).toLocaleDateString(locale)}
      </span>
      <span className={cn("hidden shrink-0 items-center gap-2 lg:flex", COLUMN_SENDER)}>
        <ActorAvatar
          actorType={invite.sent_by_agent ? ACTOR_TYPE.agent : ACTOR_TYPE.member}
          actorId={sender.id}
          name={sender.name}
          avatarUrl={sender.avatar_url}
          size="sm"
          profileRequiresDirectoryEntry
        />
        <span className="min-w-0 truncate text-label">{sender.name}</span>
      </span>
      <span className={cn("flex shrink-0 justify-end", COLUMN_ACTION)}>
        {isActive ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={revoking}
            aria-busy={revoking || undefined}
            aria-describedby={nameId}
            onClick={() => void handleRevoke()}
          >
            {t(($) => $.members.lark.revoke)}
          </Button>
        ) : null}
      </span>
    </li>
  );
}

/** 群用群头像，个人用成员头像；个人不一定是 Marvis 成员，所以不链接到成员页。 */
function TargetAvatar({ target, dimmed }: { target: LarkInviteTarget; dimmed: boolean }) {
  const dimClass = dimmed ? "opacity-60" : undefined;

  if (target.type === TARGET_TYPE.chat) {
    return <LarkChatAvatar name={target.name} avatarUrl={target.avatar_url} className={dimClass} />;
  }

  return (
    <ActorAvatar
      actorType={ACTOR_TYPE.member}
      actorId={target.id}
      name={target.name || target.id}
      avatarUrl={target.avatar_url}
      size="lg"
      profileLink={false}
      className={dimClass}
    />
  );
}

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

  return (
    <span className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-field px-2 text-caption text-muted-foreground">
      {status === INVITE_STATUS.active ? (
        <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
      ) : null}
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
    <span className={cn("hidden shrink-0 items-center gap-2 lg:flex", COLUMN_JOINED)}>
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
              className="ring-2 ring-card"
            />
          ))}
        </span>
      ) : null}
      <span className="min-w-0 truncate text-label text-muted-foreground">{summary}</span>
    </span>
  );
}
