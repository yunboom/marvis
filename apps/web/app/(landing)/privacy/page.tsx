import type { Metadata } from "next";
import { PrivacyPageClient } from "@/features/landing/components/privacy-page-client";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "How Marvis collects, uses, and protects personal information on marvis.ai and Marvis Cloud.",
  openGraph: {
    title: "Privacy Policy — Marvis",
    description:
      "How Marvis collects, uses, and protects personal information.",
    url: "/privacy",
  },
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return <PrivacyPageClient />;
}
