"use client";

import { useEffect, useState } from "react";
import { cn } from "@marvis/ui/lib/utils";
import { LARK_INVITE_ERROR_CODES, type LarkInviteErrorCode } from "@marvis/core/types";
import { useT } from "../../i18n";

/** ActorAvatar 的身份类型：成员圆形，智能体方形。 */
export const ACTOR_TYPE = {
  member: "member",
  agent: "agent",
} as const;

/** isLarkInviteErrorCode 判断服务端返回的错误码是否在界面已知的列表里。 */
export function isLarkInviteErrorCode(code: string | undefined): code is LarkInviteErrorCode {
  return code !== undefined && (LARK_INVITE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * useLarkInviteErrorText 返回按错误码取提示文案的函数。
 * 服务端的英文说明不直接展示，未知错误码统一落到 send_failed。
 */
export function useLarkInviteErrorText(): (code: string | undefined) => string {
  const { t } = useT("settings");

  return (code) => t(($) => $.members.lark.errors[isLarkInviteErrorCode(code) ? code : "send_failed"]);
}

/** 取名字的第一个字符（按码点，不会把 emoji 切成半个）。 */
function firstCharacter(name: string): string {
  return (Array.from(name.trim())[0] ?? "").toUpperCase();
}

/**
 * LarkChatAvatar 是飞书群的头像：有图片时显示图片，
 * 没有时按小队样式画白底细描边的圆角方块，里面是群名首字。
 */
export function LarkChatAvatar({
  name,
  avatarUrl,
  className,
}: {
  name: string;
  avatarUrl: string | null;
  className?: string;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    setImageFailed(false);
  }, [avatarUrl]);

  const showImage = !!avatarUrl && !imageFailed;

  return (
    <div
      data-slot="lark-chat-avatar"
      data-shape="square"
      aria-hidden="true"
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[28%] text-label font-semibold",
        !showImage && "bg-surface text-foreground ring-1 ring-surface-border",
        className,
      )}
    >
      {showImage ? (
        // 头像整体对读屏隐藏，名字紧挨着它显示。
        <img
          src={avatarUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setImageFailed(true)}
        />
      ) : (
        firstCharacter(name)
      )}
    </div>
  );
}
