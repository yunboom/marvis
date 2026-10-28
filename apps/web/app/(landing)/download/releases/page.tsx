import type { Metadata } from "next";
import { ReleasesList } from "@/features/landing/components/download/releases-list";
import { fetchRecentReleases } from "@/features/landing/utils/github-release";

// Same 5-minute window as /download: the GitHub fetch is cached for that long.
export const revalidate = 300;

export const metadata: Metadata = {
  title: "All releases",
  description: "Download any recent Marvis desktop release.",
  alternates: {
    canonical: "/download/releases",
  },
};

export default async function ReleasesPage() {
  const releases = await fetchRecentReleases();
  return <ReleasesList releases={releases} />;
}
