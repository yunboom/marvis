import type { OnboardingStep } from "./types";

/**
 * Canonical onboarding order for progress and navigation: create the
 * workspace, then connect a runtime. The runtime step's connected path
 * provisions Mika and enters chat without another progress step.
 */
export const ONBOARDING_STEP_ORDER: readonly OnboardingStep[] = [
  "workspace",
  "runtime",
] as const;
