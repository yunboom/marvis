"use client";

import { LandingHeader } from "./landing-header";
import { LandingHero } from "./landing-hero";
import { HowItWorksSection } from "./how-it-works-section";

export function MarvisLanding() {
  return (
    <div className="min-h-full bg-[#f7f7f7] text-[#0f0f0f]">
      <LandingHeader />
      <main>
        <LandingHero />
        <HowItWorksSection />
      </main>
    </div>
  );
}
