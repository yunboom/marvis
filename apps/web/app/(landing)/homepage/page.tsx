import type { Metadata } from "next";
import { MarvisLanding } from "@/features/landing/components/marvis-landing";

export const metadata: Metadata = {
  title: { absolute: "Marvis" },
  description:
    "Marvis — source-available platform that turns coding agents into real teammates. Assign tasks, track progress, compound skills.",
  openGraph: {
    title: "Marvis",
    description:
      "Manage your human + agent workforce in one place.",
    url: "/homepage",
  },
  alternates: {
    canonical: "/homepage",
  },
};

export default function HomepagePage() {
  return <MarvisLanding />;
}
