import type { Metadata } from "next";
import { MarvisLanding } from "@/features/landing/components/marvis-landing";
import { RedirectIfAuthenticated } from "@/features/landing/components/redirect-if-authenticated";

export const metadata: Metadata = {
  title: {
    absolute: "Marvis",
  },
  description:
    "Source-available platform that turns coding agents into real teammates. Assign tasks, track progress, compound skills.",
  openGraph: {
    title: "Marvis — Project Management for Human + Agent Teams",
    description:
      "Manage your human + agent workforce in one place.",
    url: "/",
  },
  alternates: {
    canonical: "/",
  },
};

export default function LandingPage() {
  return (
    <>
      <RedirectIfAuthenticated />
      <MarvisLanding />
    </>
  );
}
