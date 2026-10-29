"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Link, Loader2, Mail, MoreHorizontal, Plus, Search, Send } from "lucide-react";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink, useOptionalNavigation } from "../../navigation";
import type {
  Invitation,
  MemberRole,
  MemberWithUser,
  PurchaseWorkspaceSeatsRequest,
  ShareLink,
  WorkspaceSeatPurchasePreview,
} from "@marvis/core/types";
import { Input } from "@marvis/ui/components/ui/input";
import { Button } from "@marvis/ui/components/ui/button";
import { IconButton } from "@marvis/ui/components/common/icon-button";
import { Label } from "@marvis/ui/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@marvis/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@marvis/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@marvis/ui/components/ui/dropdown-menu";
import { cn } from "@marvis/ui/lib/utils";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@marvis/core/auth";
import {
  usePreviewWorkspaceSeatPurchase,
  usePurchaseWorkspaceSeats,
  workspaceSubscriptionSummaryOptions,
} from "@marvis/core/billing";
import { useWorkspaceId } from "@marvis/core/hooks";
import { useFeatureEnabled } from "@marvis/core/config";
import { BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG } from "@marvis/core/feature-flags";
import { useCurrentWorkspace } from "@marvis/core/paths";
import {
  invitationListOptions,
  larkInviteListOptions,
  larkInviteStatusOptions,
  memberListOptions,
  shareLinkListOptions,
  workspaceKeys,
} from "@marvis/core/workspace/queries";
import { api, errorCode } from "@marvis/core/api";
import { useLocale, useT } from "../../i18n";
import { SettingsReadOnlyNotice, SettingsTab } from "./settings-layout";
import { resolveSettingsLocation, settingsHref } from "./settings-navigation";
import { formatStripeMinorAmount } from "./billing-format";
import {
  isSingleSeatInvitePreview,
  purchasedSeatIsReadyForInvitation,
  seatInvitationCanRetryAfterPurchase,
  seatInvitationCapacityFailure,
  seatPurchaseCanRetryWithSameQuote,
  seatPurchaseMatchesPreview,
} from "./seat-invite-purchase";
import { LarkInvitesView } from "./lark-invites-view";
import { LarkInviteSendDialog } from "./lark-invite-send-dialog";
import { INVITE_STATUS, effectiveInviteStatus } from "./lark-invite-shared";
import {
  DIALOG_SHEET_ON_NARROW,
  InviteEmptyState,
  RoleChip,
  SegmentedRadio,
} from "./invite-controls";

const SEAT_PURCHASE_CONFIRM_TIMEOUT_MS = 2 * 60_000;

// How long a copy button reads "Copied" before returning to "Copy".
const COPIED_RESET_MS = 2_000;

type MembersView = "members" | "invitations" | "links" | "lark";

// Share-link lifetimes in hours; "0" means the link never expires.
const SHARE_LINK_EXPIRY = {
  day: "24",
  week: "168",
  month: "720",
  never: "0",
} as const;

type ShareLinkExpiry = (typeof SHARE_LINK_EXPIRY)[keyof typeof SHARE_LINK_EXPIRY];

const INVITE_KIND = {
  email: "email",
  lark: "lark",
  link: "link",
} as const;

type InviteKind = (typeof INVITE_KIND)[keyof typeof INVITE_KIND];

type InviteSeatPurchase = {
  workspaceId: string;
  email: string;
  role: MemberRole;
  preview: WorkspaceSeatPurchasePreview;
  idempotencyKey: string;
  phase: "review" | "purchasing" | "waiting" | "inviting" | "error";
  submittedAt?: number;
  error?: string;
  retryable?: boolean;
};

function createSeatPurchaseKey(workspaceId: string): string {
  const suffix =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `invite-seat-${workspaceId}-${suffix}`.slice(0, 200);
}

// Builds the shareable URL for a share-link invite. Prefers the navigation
// adapter's getShareableUrl (works on desktop where window.location.origin is
// not the public web origin), falling back to the browser origin on web.
function buildShareLinkUrl(
  navigation: ReturnType<typeof useOptionalNavigation>,
  code: string,
): string {
  const joinPath = `/join?code=${code}`;
  if (navigation?.getShareableUrl) {
    return navigation.getShareableUrl(joinPath);
  }
  return `${typeof window !== "undefined" ? window.location.origin : ""}${joinPath}`;
}

// 分享链接要能在浏览器里打开才有用。桌面端没有网页端时 getShareableUrl 给出的是 marvis:// 深链，
// 拿到链接的人打开后没有加入页面，此时不提供分享链接邀请，只保留邮件邀请。
const WEB_URL_PATTERN = /^https?:\/\//i;

function canShareJoinLinks(navigation: ReturnType<typeof useOptionalNavigation>): boolean {
  return WEB_URL_PATTERN.test(buildShareLinkUrl(navigation, ""));
}

// Copies text to the clipboard, falling back to a hidden textarea where the
// async clipboard API is unavailable (insecure origins). Resolves to whether
// the copy succeeded.
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand("copy");
    return true;
  } catch {
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
}

function useRoleLabels() {
  const { t } = useT("settings");
  return {
    owner: {
      label: t(($) => $.members.roles.owner.label),
      description: t(($) => $.members.roles.owner.description),
    },
    admin: {
      label: t(($) => $.members.roles.admin.label),
      description: t(($) => $.members.roles.admin.description),
    },
    member: {
      label: t(($) => $.members.roles.member.label),
      description: t(($) => $.members.roles.member.description),
    },
  } as const;
}

const ROW_CLASS = "flex items-center gap-3 border-b border-surface-border py-3";

function MemberRow({
  member,
  canManage,
  canManageOwners,
  ownerCount,
  isSelf,
  busy,
  onRoleChange,
  onRemove,
}: {
  member: MemberWithUser;
  canManage: boolean;
  canManageOwners: boolean;
  /** Total number of owners in this workspace — needed to gate demoting the
   *  last owner per `workspace.go:497-507`. */
  ownerCount: number;
  isSelf: boolean;
  busy: boolean;
  onRoleChange: (role: MemberRole) => void;
  onRemove: () => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const roleConfig = useRoleLabels();
  const canEditRole = canManage && !isSelf && (member.role !== "owner" || canManageOwners);
  const canRemove = canManage && !isSelf && (member.role !== "owner" || canManageOwners);
  const isLastOwner = member.role === "owner" && ownerCount <= 1;
  const showMenu = canEditRole || canRemove;

  return (
    <li className={ROW_CLASS}>
      <ActorAvatar actorType="member" actorId={member.user_id} size="lg" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-body font-medium">{member.name}</span>
          {isSelf ? (
            <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-field px-1.5 text-micro text-muted-foreground">
              {t(($) => $.members.you)}
            </span>
          ) : null}
        </div>
        <div className="truncate text-label text-muted-foreground">{member.email}</div>
      </div>
      <span className="w-28 shrink-0 text-label tabular-nums text-faint-foreground @max-xl:hidden">
        {t(($) => $.members.joined, {
          date: new Date(member.created_at).toLocaleDateString(locale),
        })}
      </span>
      <RoleChip role={member.role}>{roleConfig[member.role].label}</RoleChip>
      <span className="flex size-8 shrink-0 items-center justify-center">
        {showMenu && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <IconButton
                  variant="ghost"
                  size="icon"
                  disabled={busy}
                  label={t(($) => $.members.member_actions, { name: member.name })}
                >
                  <MoreHorizontal className="size-4 text-muted-foreground" />
                </IconButton>
              }
            />
            <DropdownMenuContent align="end" className="w-64">
              {canEditRole && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t(($) => $.members.change_role)}</DropdownMenuLabel>
                  {(Object.entries(roleConfig) as [MemberRole, (typeof roleConfig)[MemberRole]][]).map(
                    ([role, config]) => {
                      if (role === "owner" && !canManageOwners) return null;
                      const wouldDemoteLastOwner = isLastOwner && role !== "owner";
                      return (
                        <DropdownMenuItem
                          key={role}
                          onClick={() => (wouldDemoteLastOwner ? undefined : onRoleChange(role))}
                          disabled={wouldDemoteLastOwner}
                          title={
                            wouldDemoteLastOwner
                              ? t(($) => $.members.cannot_demote_last_owner_title)
                              : undefined
                          }
                          className="h-auto items-start py-2"
                        >
                          <div className="flex min-w-0 flex-1 flex-col">
                            <span className="font-medium">{config.label}</span>
                            <span className="text-caption font-normal text-muted-foreground">
                              {wouldDemoteLastOwner
                                ? t(($) => $.members.cannot_demote_last_owner)
                                : config.description}
                            </span>
                          </div>
                          {member.role === role ? (
                            <Check aria-hidden="true" className="mt-0.5 size-4 text-foreground" />
                          ) : null}
                        </DropdownMenuItem>
                      );
                    },
                  )}
                </DropdownMenuGroup>
              )}
              {canEditRole && canRemove && <DropdownMenuSeparator />}
              {canRemove && (
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  {t(($) => $.members.remove_action)}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </span>
    </li>
  );
}

function InvitationRow({
  invitation,
  canManage,
  onRevoke,
  busy,
}: {
  invitation: Invitation;
  canManage: boolean;
  onRevoke: () => void;
  busy: boolean;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const roleConfig = useRoleLabels();

  return (
    <li className={ROW_CLASS}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-field">
        <Mail className="size-4 text-muted-foreground" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-medium">{invitation.invitee_email}</div>
        <div className="truncate text-label text-muted-foreground">
          {t(($) => $.members.invitation_meta, {
            sent: new Date(invitation.created_at).toLocaleDateString(locale),
            expires: new Date(invitation.expires_at).toLocaleDateString(locale),
          })}
        </div>
      </div>
      <RoleChip role={invitation.role}>{roleConfig[invitation.role].label}</RoleChip>
      {canManage ? (
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          onClick={onRevoke}
          aria-label={t(($) => $.members.revoke_invitation_aria, {
            email: invitation.invitee_email,
          })}
        >
          {t(($) => $.members.revoke_confirm)}
        </Button>
      ) : null}
    </li>
  );
}

function ShareLinkRow({
  link,
  onRevoke,
  busy,
  onCopy,
}: {
  link: ShareLink;
  onRevoke: () => void;
  busy: boolean;
  onCopy: () => void;
}) {
  const { t } = useT("settings");
  const locale = useLocale();
  const roleConfig = useRoleLabels();
  const navigation = useOptionalNavigation();
  const joinUrl = buildShareLinkUrl(navigation, link.code);

  return (
    <li className="flex flex-col gap-2.5 rounded-lane bg-surface-sunken px-4 py-3.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <code className="min-w-0 flex-1 truncate font-mono text-label" title={joinUrl}>
          {joinUrl}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onCopy}
          aria-label={t(($) => $.members.share_link_copy_tooltip)}
        >
          {t(($) => $.members.share_link_copy)}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 text-label text-muted-foreground">
        <RoleChip role={link.role} className="h-5.5">
          {roleConfig[link.role].label}
        </RoleChip>
        <span>
          {t(($) => $.members.share_link_uses, { used: link.use_count, max: link.max_uses ?? "∞" })}
        </span>
        {link.expires_at ? (
          <span>
            {t(($) => $.members.share_link_expires, {
              date: new Date(link.expires_at).toLocaleDateString(locale),
            })}
          </span>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground"
          disabled={busy}
          onClick={onRevoke}
          aria-label={t(($) => $.members.share_link_revoke_tooltip)}
        >
          {t(($) => $.members.revoke_confirm)}
        </Button>
      </div>
    </li>
  );
}

/** The one header entry for all three ways to invite; each item follows its flow's own availability. */
function InviteMenu({
  items,
  onSelect,
}: {
  items: readonly InviteKind[];
  onSelect: (kind: InviteKind) => void;
}) {
  const { t } = useT("settings");

  const config: Record<InviteKind, { label: string; hint: string; icon: typeof Mail; tile: string }> = {
    email: {
      label: t(($) => $.members.invite_email_title),
      hint: t(($) => $.members.invite_menu_email_hint),
      icon: Mail,
      tile: "bg-field text-foreground",
    },
    lark: {
      label: t(($) => $.members.lark.tab),
      hint: t(($) => $.members.invite_menu_lark_hint),
      icon: Send,
      tile: "bg-identity-blue text-identity-blue-foreground",
    },
    link: {
      label: t(($) => $.members.share_links_label),
      hint: t(($) => $.members.invite_menu_link_hint),
      icon: Link,
      tile: "bg-identity-brown text-identity-brown-foreground",
    },
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button>
            <Plus />
            {t(($) => $.members.invite_menu)}
            <ChevronDown aria-hidden="true" className="opacity-70" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
        {items.map((kind) => {
          const item = config[kind];
          const Icon = item.icon;

          return (
            <DropdownMenuItem
              key={kind}
              onClick={() => onSelect(kind)}
              className="h-auto items-start gap-3 py-2.5"
            >
              <span
                aria-hidden="true"
                className={cn("flex size-8 shrink-0 items-center justify-center rounded-tile", item.tile)}
              >
                <Icon className="size-4" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{item.label}</span>
                <span className="text-caption font-normal text-muted-foreground">{item.hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Pill tabs of the members page. They never wrap: on a narrow settings column
 * the row scrolls sideways and fades out at the right edge.
 */
function MembersViewTabs({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: readonly { value: MembersView; label: string; count?: number }[];
  value: MembersView;
  onChange: (value: MembersView) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex min-w-0 max-w-full gap-1.5 overflow-x-auto [scrollbar-width:none] @max-xl:pr-6 @max-xl:[mask-image:linear-gradient(90deg,black_85%,transparent)] [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => {
        const selected = value === item.value;

        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.value)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-body whitespace-nowrap transition-colors duration-(--motion-fast) ease-out focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring @max-xl:h-8 @max-xl:px-3 @max-xl:text-label",
              selected
                ? "bg-foreground font-medium text-background"
                : "bg-field text-muted-foreground hover:bg-field-hover hover:text-foreground",
            )}
          >
            {item.label}
            {item.count !== undefined ? (
              <>
                {" "}
                <span
                  className={cn(
                    "text-caption font-normal tabular-nums",
                    selected ? "text-background/70" : "text-faint-foreground",
                  )}
                >
                  {item.count}
                </span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function MembersTab() {
  const { t } = useT("settings");
  const { t: billingT } = useT("billing");
  const locale = useLocale();
  const roleConfig = useRoleLabels();
  const user = useAuthStore((s) => s.user);
  const workspace = useCurrentWorkspace();
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  const navigation = useOptionalNavigation();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const { data: invitations = [] } = useQuery(invitationListOptions(wsId));

  const [inviteOpen, setInviteOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [larkSendOpen, setLarkSendOpen] = useState(false);
  const requestedView = resolveSettingsLocation(
    navigation?.searchParams ?? new URLSearchParams(),
  ).section;
  const urlView: MembersView =
    requestedView === "invitations" || requestedView === "links" || requestedView === "lark"
      ? requestedView
      : "members";
  const [localView, setLocalView] = useState<MembersView>(urlView);
  // With a router the URL owns the open list, so search results that land on
  // this page and back/forward switch it too. Without one it is local state.
  const view = navigation ? urlView : localView;
  const setView = (next: MembersView) => {
    if (!navigation) {
      setLocalView(next);
      return;
    }
    navigation.replace(
      settingsHref(navigation.pathname, navigation.searchParams, "members", {
        section: next === "members" ? undefined : next,
      }),
    );
  };
  const [memberQuery, setMemberQuery] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<MemberRole>("member");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteSeatPurchase, setInviteSeatPurchase] =
    useState<InviteSeatPurchase | null>(null);
  const dispatchedInvitePurchaseKey = useRef<string | null>(null);
  const [memberActionId, setMemberActionId] = useState<string | null>(null);
  const [invitationActionId, setInvitationActionId] = useState<string | null>(null);
  const [shareLinkActionId, setShareLinkActionId] = useState<string | null>(null);
  const [shareLinkLoading, setShareLinkLoading] = useState(false);
  const [shareLinkRole, setShareLinkRole] = useState<MemberRole>("member");
  const [shareLinkExpiry, setShareLinkExpiry] = useState<ShareLinkExpiry>(SHARE_LINK_EXPIRY.week);
  // The link just created; the dialog shows it for copying instead of closing.
  const [createdShareLink, setCreatedShareLink] = useState<ShareLink | null>(null);
  const [createdLinkCopied, setCreatedLinkCopied] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    confirmLabel: string;
    variant?: "destructive";
    onConfirm: () => Promise<void>;
  } | null>(null);
  const previewSeatPurchase = usePreviewWorkspaceSeatPurchase();
  const purchaseSeats = usePurchaseWorkspaceSeats(wsId);
  const seatPurchaseSummary = useQuery({
    ...workspaceSubscriptionSummaryOptions(wsId),
    enabled:
      inviteSeatPurchase?.phase === "waiting" &&
      inviteSeatPurchase.workspaceId === wsId,
    staleTime: 0,
    refetchInterval:
      inviteSeatPurchase?.phase === "waiting" ? 2_000 : false,
  });

  const currentMember = members.find((m) => m.user_id === user?.id) ?? null;
  const canManageWorkspace = currentMember?.role === "owner" || currentMember?.role === "admin";
  const isOwner = currentMember?.role === "owner";
  const ownerCount = members.filter((m) => m.role === "owner").length;
  // Only owners/admins may list share links; skip the request for plain
  // members (the server would 403) once the current member's role is known.
  const { data: shareLinks = [] } = useQuery(shareLinkListOptions(wsId, canManageWorkspace));
  // Owners/admins see the Feishu invites tab once the server's bot status is
  // known; without the bot it shows the not-configured panel instead of the
  // list. The list is only requested when the bot is available.
  const larkStatus = useQuery({ ...larkInviteStatusOptions(), enabled: canManageWorkspace }).data;
  const showLarkTab = canManageWorkspace && larkStatus !== undefined;
  const larkEnabled = showLarkTab && larkStatus.enabled;
  const { data: larkInvites = [] } = useQuery(larkInviteListOptions(wsId, larkEnabled));
  const billingEnabled = useFeatureEnabled(BILLING_WORKSPACE_SUBSCRIPTIONS_FLAG, false);
  const seats = useQuery({
    ...workspaceSubscriptionSummaryOptions(wsId),
    enabled: billingEnabled && canManageWorkspace,
  }).data?.seatCapacity;
  const needle = memberQuery.trim().toLocaleLowerCase();
  const visibleMembers = needle
    ? members.filter(
        (m) =>
          m.name.toLocaleLowerCase().includes(needle) ||
          m.email.toLocaleLowerCase().includes(needle),
      )
    : members;

  const sendInvitation = useCallback(
    async (email: string, role: MemberRole) => {
      if (!workspace) return;
      await api.createMember(workspace.id, { email, role });
      setInviteEmail("");
      setInviteRole("member");
      await qc.invalidateQueries({
        queryKey: workspaceKeys.invitations(wsId),
      });
      toast.success(t(($) => $.members.toast_invitation_sent));
    },
    [qc, t, workspace, wsId],
  );

  const handleInviteMember = async () => {
    if (!workspace) return;
    const email = inviteEmail.trim();
    const role = inviteRole;
    setInviteLoading(true);
    try {
      await sendInvitation(email, role);
      setInviteOpen(false);
    } catch (e) {
      const code = errorCode(e);
      const capacityFailure = seatInvitationCapacityFailure(code);
      if (code === "seat_capacity_overcommitted") {
        try {
          const summary = await qc.fetchQuery({
            ...workspaceSubscriptionSummaryOptions(wsId),
            staleTime: 0,
          });
          const capacity = summary?.seatCapacity;
          toast.error(
            billingT(($) => $.workspace.seats.members_over_capacity_title),
            capacity
              ? {
                  description: billingT(
                    ($) => $.workspace.seats.occupancy_over_capacity_description,
                    {
                      // Cloud refuses on used + reserved, so pending
                      // invitations have to appear here: the most common
                      // trigger is a first ledger snapshot whose member count
                      // alone still fits inside the purchased seats.
                      occupied: capacity.used + capacity.reserved,
                      purchased: capacity.purchased,
                      members: capacity.used,
                      reserved: capacity.reserved,
                    },
                  ),
                }
              : undefined,
          );
        } catch {
          toast.error(
            billingT(($) => $.workspace.seats.members_over_capacity_title),
          );
        }
        return;
      }
      if (capacityFailure === "full") {
        try {
          const preview = await previewSeatPurchase.mutateAsync({
            additionalSeats: 1,
          });
          if (!isSingleSeatInvitePreview(preview)) {
            toast.error(
              billingT(($) => $.workspace.seat_purchase.preview_unreadable),
            );
            return;
          }
          // Hand over to the purchase confirmation rather than stacking a
          // second modal on the invite dialog.
          setInviteOpen(false);
          setInviteSeatPurchase({
            workspaceId: workspace.id,
            email,
            role,
            preview,
            idempotencyKey: createSeatPurchaseKey(workspace.id),
            phase: "review",
          });
          dispatchedInvitePurchaseKey.current = null;
        } catch (previewError) {
          toast.error(
            errorCode(previewError) === "seat_purchase_in_progress"
              ? billingT(($) => $.workspace.seat_purchase.in_progress)
              : billingT(($) => $.workspace.seat_purchase.preview_failed),
          );
        }
        return;
      }
      if (capacityFailure === "unavailable") {
        toast.error(t(($) => $.members.toast_seat_capacity_unavailable));
        return;
      }
      if (capacityFailure === "rate_limited") {
        toast.error(t(($) => $.members.toast_seat_capacity_rate_limited));
        return;
      }
      toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_invitation_failed));
    } finally {
      setInviteLoading(false);
    }
  };

  const handlePurchaseSeatAndInvite = async () => {
    if (
      !inviteSeatPurchase ||
      (inviteSeatPurchase.phase !== "review" &&
        !(inviteSeatPurchase.phase === "error" && inviteSeatPurchase.retryable))
    ) {
      return;
    }
    const current = inviteSeatPurchase;
    if (!workspace || current.workspaceId !== workspace.id) {
      setInviteSeatPurchase(null);
      return;
    }
    // A transient failure may happen after the purchase succeeded and the
    // first invitation dispatch ran. Reusing the same idempotency key is safe,
    // but the dispatch guard must be reopened for the retried invitation.
    dispatchedInvitePurchaseKey.current = null;
    setInviteSeatPurchase({
      ...current,
      phase: "purchasing",
      error: undefined,
      retryable: false,
    });
    const request: PurchaseWorkspaceSeatsRequest = {
      additionalSeats: current.preview.additionalSeats,
      expectedCurrentSeats: current.preview.currentSeats,
      expectedPurchaseVersion: current.preview.purchaseVersion,
      acceptedProrationAmount: current.preview.prorationAmount,
      currency: current.preview.currency,
      idempotencyKey: current.idempotencyKey,
    };
    try {
      const response = await purchaseSeats.mutateAsync(request);
      if (!seatPurchaseMatchesPreview(response, current.preview)) {
        setInviteSeatPurchase({
          ...current,
          phase: "error",
          error: billingT(
            ($) => $.workspace.seat_purchase.purchase_unreadable,
          ),
          retryable: true,
        });
        return;
      }
      const submittedAt = Date.now();
      setInviteSeatPurchase({
        ...current,
        phase: "waiting",
        submittedAt,
        error: undefined,
        retryable: false,
      });
      await qc.invalidateQueries({
        queryKey: workspaceSubscriptionSummaryOptions(wsId).queryKey,
      });
    } catch (error) {
      const code = errorCode(error);
      const message =
        code === "seat_purchase_payment_failed"
          ? billingT(($) => $.workspace.seat_purchase.payment_failed)
          : code === "seat_purchase_in_progress"
            ? billingT(($) => $.workspace.seat_purchase.in_progress)
            : code === "seat_quote_changed" || code === "seat_capacity_changed"
              ? billingT(($) => $.workspace.seat_purchase.quote_changed)
              : billingT(($) => $.workspace.seat_purchase.purchase_failed);
      setInviteSeatPurchase({
        ...current,
        phase: "error",
        error: message,
        retryable: seatPurchaseCanRetryWithSameQuote(code),
      });
    }
  };

  useEffect(() => {
    setInviteSeatPurchase((current) =>
      current && current.workspaceId !== wsId ? null : current,
    );
  }, [wsId]);

  useEffect(() => {
    const purchase = inviteSeatPurchase;
    if (
      purchase?.phase !== "waiting" ||
      purchase.workspaceId !== wsId ||
      purchase.submittedAt == null ||
      dispatchedInvitePurchaseKey.current === purchase.idempotencyKey ||
      !purchasedSeatIsReadyForInvitation(
        seatPurchaseSummary.data,
        purchase.preview,
        purchase.submittedAt,
        seatPurchaseSummary.dataUpdatedAt,
      )
    ) {
      return;
    }

    dispatchedInvitePurchaseKey.current = purchase.idempotencyKey;
    setInviteSeatPurchase({ ...purchase, phase: "inviting" });
    void sendInvitation(purchase.email, purchase.role)
      .then(() => setInviteSeatPurchase(null))
      .catch((error) => {
        const code = errorCode(error);
        const capacityFailure = seatInvitationCapacityFailure(code);
        let message: string;
        switch (capacityFailure) {
          case "full":
            message = t(($) => $.members.seat_purchase_capacity_taken);
            break;
          case "unavailable":
            message = t(($) => $.members.toast_seat_capacity_unavailable);
            break;
          case "rate_limited":
            message = t(($) => $.members.toast_seat_capacity_rate_limited);
            break;
          default:
            message =
              error instanceof Error
                ? error.message
                : t(($) => $.members.toast_invitation_failed);
        }
        setInviteSeatPurchase({
          ...purchase,
          phase: "error",
          retryable: seatInvitationCanRetryAfterPurchase(code),
          error: message,
        });
      });
  }, [
    inviteSeatPurchase,
    seatPurchaseSummary.data,
    seatPurchaseSummary.dataUpdatedAt,
    sendInvitation,
    t,
    wsId,
  ]);

  useEffect(() => {
    if (
      inviteSeatPurchase?.phase !== "waiting" ||
      inviteSeatPurchase.submittedAt == null
    ) {
      return;
    }
    const elapsed = Date.now() - inviteSeatPurchase.submittedAt;
    const timeout = window.setTimeout(() => {
      setInviteSeatPurchase((current) =>
        current?.phase === "waiting"
          ? {
              ...current,
              phase: "error",
              error: t(($) => $.members.seat_purchase_timeout),
              retryable: false,
            }
          : current,
      );
    }, Math.max(0, SEAT_PURCHASE_CONFIRM_TIMEOUT_MS - elapsed));
    return () => window.clearTimeout(timeout);
  }, [inviteSeatPurchase?.phase, inviteSeatPurchase?.submittedAt, t]);

  const handleRevokeInvitation = (invitation: Invitation) => {
    if (!workspace) return;
    setConfirmAction({
      title: t(($) => $.members.revoke_invitation_title),
      description: t(($) => $.members.revoke_invitation_description, { email: invitation.invitee_email }),
      confirmLabel: t(($) => $.members.revoke_confirm),
      variant: "destructive",
      onConfirm: async () => {
        setInvitationActionId(invitation.id);
        try {
          await api.revokeInvitation(workspace.id, invitation.id);
          qc.invalidateQueries({ queryKey: workspaceKeys.invitations(wsId) });
          toast.success(t(($) => $.members.toast_invitation_revoked));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_invitation_revoke_failed));
        } finally {
          setInvitationActionId(null);
        }
      },
    });
  };

  const handleRoleChange = async (memberId: string, role: MemberRole) => {
    if (!workspace) return;
    setMemberActionId(memberId);
    try {
      await api.updateMember(workspace.id, memberId, { role });
      qc.invalidateQueries({ queryKey: workspaceKeys.members(wsId) });
      toast.success(t(($) => $.members.toast_role_updated));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_role_failed));
    } finally {
      setMemberActionId(null);
    }
  };

  const handleRemoveMember = (member: MemberWithUser) => {
    if (!workspace) return;
    setConfirmAction({
      title: t(($) => $.members.remove_member_title, { name: member.name }),
      description: t(($) => $.members.remove_member_description, { name: member.name, workspace: workspace.name }),
      confirmLabel: t(($) => $.members.remove_confirm),
      variant: "destructive",
      onConfirm: async () => {
        setMemberActionId(member.id);
        try {
          await api.deleteMember(workspace.id, member.id);
          qc.invalidateQueries({ queryKey: workspaceKeys.members(wsId) });
          toast.success(t(($) => $.members.toast_member_removed));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_member_remove_failed));
        } finally {
          setMemberActionId(null);
        }
      },
    });
  };

  const openShareLinkDialog = () => {
    setCreatedShareLink(null);
    setCreatedLinkCopied(false);
    setShareLinkOpen(true);
  };

  const handleCreateShareLink = async () => {
    if (!workspace) return;
    setShareLinkLoading(true);
    try {
      const link = await api.createShareLink(workspace.id, {
        role: shareLinkRole,
        expires_in: parseInt(shareLinkExpiry) || undefined,
      });
      qc.invalidateQueries({ queryKey: workspaceKeys.shareLinks(wsId) });
      setCreatedShareLink(link);
      toast.success(t(($) => $.members.toast_share_link_created));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_share_link_failed));
    } finally {
      setShareLinkLoading(false);
    }
  };

  const handleRevokeShareLink = (link: ShareLink) => {
    if (!workspace) return;
    setConfirmAction({
      title: t(($) => $.members.revoke_share_link_title),
      description: t(($) => $.members.revoke_share_link_description),
      confirmLabel: t(($) => $.members.revoke_confirm),
      variant: "destructive",
      onConfirm: async () => {
        setShareLinkActionId(link.id);
        try {
          await api.revokeShareLink(workspace.id, link.id);
          qc.invalidateQueries({ queryKey: workspaceKeys.shareLinks(wsId) });
          toast.success(t(($) => $.members.toast_share_link_revoked));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t(($) => $.members.toast_share_link_revoke_failed));
        } finally {
          setShareLinkActionId(null);
        }
      },
    });
  };

  const copyShareLink = async (link: ShareLink): Promise<boolean> => {
    const copied = await copyText(buildShareLinkUrl(navigation, link.code));
    if (copied) {
      toast.success(t(($) => $.members.toast_share_link_copied));
    } else {
      toast.error(t(($) => $.members.toast_share_link_copy_failed));
    }

    return copied;
  };

  const handleCopyCreatedLink = async () => {
    if (!createdShareLink) return;

    const copied = await copyShareLink(createdShareLink);
    if (!copied) return;

    setCreatedLinkCopied(true);
    window.setTimeout(() => setCreatedLinkCopied(false), COPIED_RESET_MS);
  };

  const handleInviteMenu = (kind: InviteKind) => {
    if (kind === INVITE_KIND.email) setInviteOpen(true);
    else if (kind === INVITE_KIND.lark) setLarkSendOpen(true);
    else openShareLinkDialog();
  };

  if (!workspace) return null;

  const roleItems = (["member", "admin"] as const).map((value) => ({
    value,
    label: roleConfig[value].label,
  }));
  const expiryOptions: { value: ShareLinkExpiry; label: string }[] = [
    { value: SHARE_LINK_EXPIRY.day, label: t(($) => $.members.expiry_24h) },
    { value: SHARE_LINK_EXPIRY.week, label: t(($) => $.members.expiry_7d) },
    { value: SHARE_LINK_EXPIRY.month, label: t(($) => $.members.expiry_30d) },
    { value: SHARE_LINK_EXPIRY.never, label: t(($) => $.members.expiry_never) },
  ];
  const canShareLinks = canManageWorkspace && canShareJoinLinks(navigation);
  const inviteKinds: InviteKind[] = [
    ...(canManageWorkspace ? [INVITE_KIND.email] : []),
    ...(larkEnabled ? [INVITE_KIND.lark] : []),
    ...(canShareLinks ? [INVITE_KIND.link] : []),
  ];
  const views: { value: MembersView; label: string; count?: number }[] = [
    { value: "members", label: t(($) => $.members.members_label), count: members.length },
    { value: "invitations", label: t(($) => $.members.pending_label), count: invitations.length },
    ...(canShareLinks
      ? [{ value: "links" as const, label: t(($) => $.members.share_links_label), count: shareLinks.length }]
      : []),
    ...(showLarkTab
      ? [
          {
            value: "lark" as const,
            label: t(($) => $.members.lark.tab),
            count: larkEnabled
              ? larkInvites.filter(
                  (invite) => effectiveInviteStatus(invite) === INVITE_STATUS.active,
                ).length
              : undefined,
          },
        ]
      : []),
  ];
  const activeView = views.some((item) => item.value === view) ? view : "members";
  const createdLinkUrl = createdShareLink ? buildShareLinkUrl(navigation, createdShareLink.code) : "";
  const createdLinkExpiry = createdShareLink
    ? (expiryOptions.find((option) => option.value === shareLinkExpiry)?.label ?? "")
    : "";

  return (
    <SettingsTab
      title={t(($) => $.page.tabs.members)}
      scope="workspace"
      actions={
        inviteKinds.length > 0 ? (
          <InviteMenu items={inviteKinds} onSelect={handleInviteMenu} />
        ) : undefined
      }
    >
      {currentMember && !canManageWorkspace ? (
        <SettingsReadOnlyNotice wsId={wsId} />
      ) : null}
      <section className="@container space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <MembersViewTabs
            label={t(($) => $.page.tabs.members)}
            items={views}
            value={activeView}
            onChange={setView}
          />
          <div className="flex min-w-0 flex-wrap items-center gap-3 @max-xl:w-full">
            {seats && billingEnabled ? (
              <span className="shrink-0 text-caption text-muted-foreground">
                {t(($) => $.members.seats_used, {
                  used: seats.used + seats.reserved,
                  purchased: seats.purchased,
                })}
                {" · "}
                <AppLink
                  href={
                    navigation
                      ? settingsHref(navigation.pathname, navigation.searchParams, "billing")
                      : "?tab=billing"
                  }
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {t(($) => $.members.manage_seats)}
                </AppLink>
              </span>
            ) : null}
            {activeView === "members" ? (
              <div className="relative w-60 @max-xl:w-full">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={memberQuery}
                  onChange={(event) => setMemberQuery(event.target.value)}
                  placeholder={t(($) => $.members.search_placeholder)}
                  aria-label={t(($) => $.members.search_placeholder)}
                  className="rounded-full pl-9"
                />
              </div>
            ) : null}
          </div>
        </div>

        {activeView === "members" ? (
          visibleMembers.length > 0 ? (
            <ul>
              {visibleMembers.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  canManage={canManageWorkspace}
                  canManageOwners={isOwner}
                  ownerCount={ownerCount}
                  isSelf={m.user_id === user?.id}
                  busy={memberActionId === m.id}
                  onRoleChange={(role) => handleRoleChange(m.id, role)}
                  onRemove={() => handleRemoveMember(m)}
                />
              ))}
            </ul>
          ) : (
            <InviteEmptyState>
              {needle ? t(($) => $.members.no_results) : t(($) => $.members.no_members)}
            </InviteEmptyState>
          )
        ) : activeView === "invitations" ? (
          invitations.length > 0 ? (
            <ul>
              {invitations.map((inv) => (
                <InvitationRow
                  key={inv.id}
                  invitation={inv}
                  canManage={canManageWorkspace}
                  onRevoke={() => handleRevokeInvitation(inv)}
                  busy={invitationActionId === inv.id}
                />
              ))}
            </ul>
          ) : (
            <InviteEmptyState
              action={
                canManageWorkspace ? (
                  <Button size="sm" onClick={() => setInviteOpen(true)}>
                    {t(($) => $.members.invite_email_title)}
                  </Button>
                ) : undefined
              }
            >
              {t(($) => $.members.no_invitations)}
            </InviteEmptyState>
          )
        ) : activeView === "lark" ? (
          <LarkInvitesView wsId={wsId} onSend={() => setLarkSendOpen(true)} />
        ) : shareLinks.length > 0 ? (
          <ul className="space-y-2.5">
            {shareLinks.map((link) => (
              <ShareLinkRow
                key={link.id}
                link={link}
                onRevoke={() => handleRevokeShareLink(link)}
                busy={shareLinkActionId === link.id}
                onCopy={() => void copyShareLink(link)}
              />
            ))}
          </ul>
        ) : (
          <InviteEmptyState
            action={
              <Button size="sm" onClick={openShareLinkDialog}>
                {t(($) => $.members.share_links_create_title)}
              </Button>
            }
          >
            {t(($) => $.members.no_share_links)}
          </InviteEmptyState>
        )}
      </section>

      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          if (!open && !inviteLoading) setInviteOpen(false);
        }}
      >
        <DialogContent className={cn("gap-5 sm:max-w-md", DIALOG_SHEET_ON_NARROW)}>
          <DialogHeader>
            <DialogTitle>{t(($) => $.members.invite_email_title)}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (inviteEmail.trim()) void handleInviteMember();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">{t(($) => $.members.email_label)}</Label>
              <Input
                id="invite-email"
                type="email"
                name="invite-email"
                autoComplete="email"
                spellCheck={false}
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder={t(($) => $.members.invite_email_placeholder)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <p id="invite-role-label" className="text-label font-medium">
                {t(($) => $.members.role_label)}
              </p>
              <div role="radiogroup" aria-labelledby="invite-role-label" className="space-y-2">
                {roleItems.map((item) => {
                  const checked = inviteRole === item.value;

                  return (
                    <button
                      key={item.value}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      onClick={() => setInviteRole(item.value)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-option border-[1.5px] px-3.5 py-3 text-left transition-colors duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-ring",
                        checked
                          ? "border-foreground bg-surface"
                          : "border-transparent bg-surface-sunken hover:bg-surface-hover",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-4.5 shrink-0 items-center justify-center rounded-full border-2",
                          checked ? "border-foreground" : "border-faint-foreground",
                        )}
                      >
                        {checked ? <span className="size-2 rounded-full bg-foreground" /> : null}
                      </span>
                      <span className="flex min-w-0 flex-col">
                        <span className="text-body font-medium">{item.label}</span>
                        <span className="text-caption text-muted-foreground">
                          {roleConfig[item.value].description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setInviteOpen(false)}
                disabled={inviteLoading}
              >
                {t(($) => $.members.confirm_cancel)}
              </Button>
              <Button
                type="submit"
                disabled={inviteLoading || !inviteEmail.trim()}
                aria-busy={inviteLoading || undefined}
              >
                {inviteLoading ? t(($) => $.members.inviting) : t(($) => $.members.invite_button)}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={shareLinkOpen}
        onOpenChange={(open) => {
          if (!open && !shareLinkLoading) setShareLinkOpen(false);
        }}
      >
        <DialogContent className={cn("gap-5 sm:max-w-md", DIALOG_SHEET_ON_NARROW)}>
          <DialogHeader>
            <DialogTitle>{t(($) => $.members.share_links_create_title)}</DialogTitle>
            <DialogDescription>
              {createdShareLink
                ? t(($) => $.members.share_link_created_summary, {
                    role: roleConfig[createdShareLink.role].label,
                    expiry: createdLinkExpiry,
                  })
                : t(($) => $.members.share_links_description)}
            </DialogDescription>
          </DialogHeader>
          {createdShareLink ? (
            <>
              <div className="flex min-w-0 items-center gap-2 rounded-option bg-surface-sunken py-2 pr-2 pl-3.5">
                <code className="min-w-0 flex-1 truncate font-mono text-label" title={createdLinkUrl}>
                  {createdLinkUrl}
                </code>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => void handleCopyCreatedLink()}
                  aria-label={t(($) => $.members.share_link_copy_tooltip)}
                >
                  {createdLinkCopied
                    ? t(($) => $.members.share_link_copied)
                    : t(($) => $.members.share_link_copy)}
                </Button>
              </div>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => setShareLinkOpen(false)}>
                  {t(($) => $.members.done)}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-label font-medium">{t(($) => $.members.role_label)}</p>
                <SegmentedRadio
                  label={t(($) => $.members.role_label)}
                  options={roleItems}
                  value={shareLinkRole === "admin" ? "admin" : "member"}
                  onChange={setShareLinkRole}
                />
              </div>
              <div className="space-y-2">
                <p className="text-label font-medium">{t(($) => $.members.expiry_label)}</p>
                <SegmentedRadio
                  label={t(($) => $.members.expiry_label)}
                  options={expiryOptions}
                  value={shareLinkExpiry}
                  onChange={setShareLinkExpiry}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setShareLinkOpen(false)}
                  disabled={shareLinkLoading}
                >
                  {t(($) => $.members.confirm_cancel)}
                </Button>
                <Button
                  onClick={() => void handleCreateShareLink()}
                  disabled={shareLinkLoading}
                  aria-busy={shareLinkLoading || undefined}
                >
                  {shareLinkLoading
                    ? t(($) => $.members.share_links_creating)
                    : t(($) => $.members.share_links_create_button)}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {larkEnabled ? (
        <LarkInviteSendDialog wsId={wsId} open={larkSendOpen} onOpenChange={setLarkSendOpen} />
      ) : null}

      <AlertDialog
        open={inviteSeatPurchase !== null}
        onOpenChange={(open) => {
          if (
            !open &&
            (inviteSeatPurchase?.phase === "review" ||
              inviteSeatPurchase?.phase === "error")
          ) {
            setInviteSeatPurchase(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.members.seat_purchase_title)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {inviteSeatPurchase?.phase === "review"
                ? t(($) => $.members.seat_purchase_description, {
                    email: inviteSeatPurchase.email,
                  })
                : inviteSeatPurchase?.phase === "error"
                  ? inviteSeatPurchase.error
                  : t(($) => $.members.seat_purchase_waiting)}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {inviteSeatPurchase?.phase === "review" && (
            <div className="divide-y divide-surface-border rounded-option bg-surface-sunken text-body">
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-muted-foreground">
                  {billingT(($) => $.workspace.seat_purchase.seats_after)}
                </span>
                <span className="font-medium">
                  {billingT(($) => $.workspace.seats.seat_count, {
                    count: inviteSeatPurchase.preview.resultingSeats,
                  })}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-muted-foreground">
                  {billingT(($) => $.workspace.seat_purchase.charge_today)}
                </span>
                <span className="font-medium">
                  {formatStripeMinorAmount(
                    inviteSeatPurchase.preview.prorationAmount,
                    inviteSeatPurchase.preview.currency,
                    locale,
                  ) ?? "—"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 px-4 py-3">
                <span className="text-muted-foreground">
                  {billingT(($) => $.workspace.seat_purchase.next_invoice)}
                </span>
                <span className="font-medium">
                  {formatStripeMinorAmount(
                    inviteSeatPurchase.preview.nextInvoiceAmount,
                    inviteSeatPurchase.preview.currency,
                    locale,
                  ) ?? "—"}
                </span>
              </div>
              <p className="px-4 py-3 text-caption text-muted-foreground">
                {billingT(($) => $.workspace.seat_purchase.tax_notice)}
              </p>
            </div>
          )}

          {(inviteSeatPurchase?.phase === "purchasing" ||
            inviteSeatPurchase?.phase === "waiting" ||
            inviteSeatPurchase?.phase === "inviting") && (
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {inviteSeatPurchase.phase === "inviting"
                ? t(($) => $.members.inviting)
                : t(($) => $.members.seat_purchase_waiting)}
            </div>
          )}

          <AlertDialogFooter>
            {(inviteSeatPurchase?.phase === "review" ||
              inviteSeatPurchase?.phase === "error") && (
              <AlertDialogCancel>
                {t(($) => $.members.confirm_cancel)}
              </AlertDialogCancel>
            )}
            {inviteSeatPurchase?.phase === "review" && (
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  void handlePurchaseSeatAndInvite();
                }}
              >
                {t(($) => $.members.purchase_seat_and_invite)}
              </AlertDialogAction>
            )}
            {inviteSeatPurchase?.phase === "error" &&
              inviteSeatPurchase.retryable && (
                <AlertDialogAction
                  onClick={(event) => {
                    event.preventDefault();
                    void handlePurchaseSeatAndInvite();
                  }}
                >
                  {t(($) => $.members.retry_seat_purchase)}
                </AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmAction} onOpenChange={(v) => { if (!v) setConfirmAction(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmAction?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmAction?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.members.confirm_cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmAction?.variant === "destructive" ? "destructive" : "default"}
              onClick={async () => {
                await confirmAction?.onConfirm();
                setConfirmAction(null);
              }}
            >
              {confirmAction?.confirmLabel ?? t(($) => $.members.confirm_action)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsTab>
  );
}
