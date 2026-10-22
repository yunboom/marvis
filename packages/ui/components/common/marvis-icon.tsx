import { useState, useEffect, useId } from "react";
import { cn } from "../../lib/utils";

interface MarvisIconProps extends React.ComponentProps<"span"> {
  /**
   * If true, play the one-time logo intro animation.
   */
  animate?: boolean;
  /**
   * Kept for call-site compatibility; the mark has no hover animation.
   */
  noSpin?: boolean;
  /**
   * If true, show a border around the icon.
   */
  bordered?: boolean;
  /**
   * Size of the bordered icon: "sm" (default), "md", "lg"
   */
  size?: "sm" | "md" | "lg";
}

const borderedSizes = {
  sm: { wrapper: "p-1.5", icon: "size-3.5" },
  md: { wrapper: "p-2", icon: "size-4" },
  lg: { wrapper: "p-2.5", icon: "size-5" },
};

// Matches the length of the logo-intro keyframes in base.css.
const INTRO_DURATION_MS = 566;

/**
 * The Marvis mark: a rounded square in currentColor with the "M" knocked out,
 * so the letter always shows the surface behind it and the mark follows the
 * text colour of its context in both themes. Sized in em.
 */
function Mark({ className, playIntro }: { className?: string; playIntro: boolean }) {
  // useId() may contain characters that are not valid in a url(#id) reference.
  const maskId = `marvis-mark-${useId().replace(/[^\w-]/g, "")}`;

  return (
    <svg
      viewBox="0 0 100 100"
      className={cn("block size-[1em] origin-center", playIntro && "animate-logo-intro", className)}
      aria-hidden="true"
    >
      <mask id={maskId}>
        <rect width="100" height="100" fill="white" />
        <polygon points="27,70 27,30 39,30 50,50 61,30 73,30 73,70 63,70 63,46 54,62 46,62 37,46 37,70" fill="black" />
      </mask>
      <rect width="100" height="100" rx="26" fill="currentColor" mask={`url(#${maskId})`} />
    </svg>
  );
}

export function MarvisIcon({
  className,
  animate = false,
  noSpin: _noSpin = false,
  bordered = false,
  size = "sm",
  ...props
}: MarvisIconProps) {
  const [introDone, setIntroDone] = useState(!animate);

  useEffect(() => {
    if (!animate) return;
    const timer = setTimeout(() => setIntroDone(true), INTRO_DURATION_MS);
    return () => clearTimeout(timer);
  }, [animate]);

  if (bordered) {
    const sizeConfig = borderedSizes[size];
    return (
      <span
        className={cn(
          "inline-flex items-center justify-center border border-border rounded-md",
          sizeConfig.wrapper,
          className
        )}
        aria-hidden="true"
        {...props}
      >
        <Mark className={cn("block", sizeConfig.icon)} playIntro={!introDone} />
      </span>
    );
  }

  return (
    <span
      className={cn("inline-flex size-[1em]", className)}
      aria-hidden="true"
      {...props}
    >
      <Mark className="size-full" playIntro={!introDone} />
    </span>
  );
}
