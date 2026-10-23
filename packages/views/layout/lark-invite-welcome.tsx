"use client";

import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@marvis/core/api";
import {
  larkInviteWelcomeOptions,
  workspaceKeys,
} from "@marvis/core/workspace/queries";
import { useT } from "../i18n";

interface LarkInviteWelcomeProps {
  wsId: string;
  workspaceName: string;
}

/**
 * LarkInviteWelcome 在用户通过飞书邀请卡片加入后首次进入工作区时弹出一次提示。
 *
 * 待提示的记录记在服务端，只在 ack 之后才会消失。加载中或请求失败时什么都不显示；
 * ack 失败也保持静默，服务端下次进入时会再次提示。
 */
export function LarkInviteWelcome({
  wsId,
  workspaceName,
}: LarkInviteWelcomeProps): null {
  const { t } = useT("layout");
  const { t: tMembers } = useT("members");
  const qc = useQueryClient();
  const { data: welcome } = useQuery(larkInviteWelcomeOptions(wsId));

  // 同一次挂载内每个工作区只提示一次，不依赖查询缓存是否已被清掉。
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!welcome) return;
    if (shownRef.current.has(wsId)) return;
    shownRef.current.add(wsId);

    toast.success(
      t(($) => $.lark_invite_welcome.title, { workspace: workspaceName }),
      {
        description: t(($) => $.lark_invite_welcome.description, {
          inviter: welcome.inviter_name,
          role: tMembers(($) => $.role[welcome.role]),
        }),
      },
    );

    // ack 成功后把缓存置空，之后的重新渲染不会再命中这条记录。
    // 失败时不提示也不重试：缓存保持原样，下次进入工作区时由服务端再次提示。
    void api
      .ackLarkInviteWelcome(wsId)
      .then(() => {
        qc.setQueryData(workspaceKeys.larkInviteWelcome(wsId), null);
      })
      .catch(() => undefined);
  }, [welcome, wsId, workspaceName, t, tMembers, qc]);

  return null;
}
