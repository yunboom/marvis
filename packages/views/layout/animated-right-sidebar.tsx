"use client";

import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { motion } from "motion/react";
import type { Layout, PanelProps, PanelSize } from "react-resizable-panels";
import {
  isEditableShortcutTarget,
  shortcutMatchesEvent,
  useShortcut,
} from "@marvis/core/shortcuts";
import { isImeComposing } from "@marvis/core/utils";
import { ResizablePanel } from "@marvis/ui/components/ui/resizable";
import { cn } from "@marvis/ui/lib/utils";

const rightSidebarPanelMotionProps = {
  "data-right-sidebar-panel": "true",
  style: { overflowX: "hidden" },
} as const;

const RIGHT_SIDEBAR_PANEL_TRANSITION_MS = 220;
const RIGHT_SIDEBAR_PANEL_SETTLE_MS = RIGHT_SIDEBAR_PANEL_TRANSITION_MS + 80;

const rightSidebarTransition = {
  type: "spring",
  stiffness: 420,
  damping: 38,
  mass: 0.8,
} as const;

export function getAnimatedRightSidebarInitialOpen(
  defaultOpen: boolean,
  defaultLayout: Layout | undefined,
  panelId = "sidebar",
) {
  const restoredSize = defaultLayout?.[panelId];
  return typeof restoredSize === "number" ? restoredSize > 0 : defaultOpen;
}

function isRightSidebarPanelOpen(size: PanelSize) {
  return size.asPercentage > 0 || size.inPixels > 0;
}

export interface RightSidebarState {
  open: boolean;
  visualOpen: boolean;
  motionEnabled: boolean;
}

/**
 * Open/motion state of a detail page's right sidebar, kept outside React so a
 * toggle re-renders only its subscribers (the toggle button and the panel),
 * not the whole detail page that owns it.
 */
export interface RightSidebarController {
  getState: () => RightSidebarState;
  subscribe: (listener: () => void) => () => void;
  beginToggle: (nextOpen: boolean) => void;
  handleResize: (size: PanelSize) => void;
  dispose: () => void;
}

function createRightSidebarController(initialOpen: boolean): RightSidebarController {
  let state: RightSidebarState = {
    open: initialOpen,
    visualOpen: initialOpen,
    motionEnabled: false,
  };
  const listeners = new Set<() => void>();
  let toggleTarget: boolean | null = null;
  let settleTimeout: ReturnType<typeof setTimeout> | null = null;

  const setState = (patch: Partial<RightSidebarState>) => {
    const next = { ...state, ...patch };
    if (
      next.open === state.open &&
      next.visualOpen === state.visualOpen &&
      next.motionEnabled === state.motionEnabled
    ) {
      return;
    }

    state = next;
    listeners.forEach((listener) => listener());
  };

  const clearSettle = () => {
    if (settleTimeout) clearTimeout(settleTimeout);
    settleTimeout = null;
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    beginToggle: (nextOpen) => {
      toggleTarget = nextOpen;
      setState({ open: nextOpen, visualOpen: nextOpen, motionEnabled: true });

      clearSettle();
      settleTimeout = setTimeout(() => {
        toggleTarget = null;
        settleTimeout = null;
        setState({ motionEnabled: false });
      }, RIGHT_SIDEBAR_PANEL_SETTLE_MS);
    },
    handleResize: (size) => {
      const nextOpen = isRightSidebarPanelOpen(size);
      if (toggleTarget === null) {
        setState({ open: nextOpen, visualOpen: nextOpen });
        return;
      }

      setState({ open: toggleTarget });
    },
    dispose: clearSettle,
  };
}

export function useRightSidebarController(initialOpen: boolean): RightSidebarController {
  const [controller] = useState(() => createRightSidebarController(initialOpen));

  useEffect(() => controller.dispose, [controller]);

  return controller;
}

export function useRightSidebarState(controller: RightSidebarController): RightSidebarState {
  return useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
}

/** Renders the sidebar toggle from the live open state, isolated from the page. */
export function RightSidebarOpenState({
  controller,
  children,
}: {
  controller: RightSidebarController;
  children: (open: boolean) => ReactNode;
}) {
  const { open } = useRightSidebarState(controller);
  return children(open);
}

/** The collapsible right panel of a detail page, animated on toggle. */
export function AnimatedRightSidebarPanel({
  controller,
  panelRef,
  children,
}: {
  controller: RightSidebarController;
  panelRef: PanelProps["panelRef"];
  children: ReactNode;
}) {
  const { open, visualOpen, motionEnabled } = useRightSidebarState(controller);

  return (
    <ResizablePanel
      id="sidebar"
      {...rightSidebarPanelMotionProps}
      data-right-sidebar-motion={motionEnabled ? "enabled" : undefined}
      defaultSize={open ? 320 : 0}
      minSize={260}
      maxSize={420}
      collapsible
      groupResizeBehavior="preserve-pixel-size"
      panelRef={panelRef}
      onResize={controller.handleResize}
    >
      <AnimatedRightSidebar open={visualOpen} motionEnabled={motionEnabled}>
        {children}
      </AnimatedRightSidebar>
    </ResizablePanel>
  );
}

/** Toggle the right sidebar only for the visible detail page that owns it. */
export function useRightSidebarShortcut(
  targetRef: RefObject<HTMLElement | null>,
  onToggle: () => void,
) {
  const shortcut = useShortcut("toggleRightSidebar");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isImeComposing(event)) return;
      if (isEditableShortcutTarget(event.target)) return;
      if (!shortcutMatchesEvent(shortcut, event)) return;

      const target = targetRef.current;
      if (!target || target.getClientRects().length === 0) return;

      event.preventDefault();
      onToggle();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onToggle, shortcut, targetRef]);
}

export function AnimatedRightSidebar({
  open,
  motionEnabled,
  children,
  className,
}: {
  open: boolean;
  motionEnabled?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      animate={{ opacity: open ? 1 : 0, x: open ? 0 : 12 }}
      // `relative` makes this scroller the containing block of absolutely
      // positioned descendants (`sr-only` labels in the execution log, etc.).
      // Without it they resolve against an ancestor outside the scroller:
      // they escape its clip and stretch the enclosing panel's scroll height,
      // so wheeling past the end of the comments scrolled the whole issue
      // detail up and left a blank band at the bottom (MUL-8100).
      className={cn(
        "relative h-full overflow-x-hidden overflow-y-auto border-l",
        !open && "pointer-events-none",
        className,
      )}
      initial={false}
      transition={motionEnabled ? rightSidebarTransition : { duration: 0 }}
    >
      <div className="p-4">{children}</div>
    </motion.div>
  );
}
