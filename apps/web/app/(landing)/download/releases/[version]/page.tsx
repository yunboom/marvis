import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReleaseDetail } from "@/features/landing/components/download/release-detail";
import { fetchRecentReleases } from "@/features/landing/utils/github-release";

export const revalidate = 300;

type Params = Promise<{ version: string }>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { version } = await params;
  return {
    title: `Marvis ${decodeURIComponent(version)}`,
    alternates: {
      canonical: `/download/releases/${version}`,
    },
  };
}

export default async function ReleaseDetailPage({ params }: { params: Params }) {
  const { version } = await params;
  const tag = decodeURIComponent(version);
  const releases = await fetchRecentReleases();
  const index = releases.findIndex((r) => r.version === tag);
  if (index === -1) notFound();

  return <ReleaseDetail release={releases[index]!} isLatest={index === 0} />;
}
