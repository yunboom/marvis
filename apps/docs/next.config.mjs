import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// Mirrors lib/base-path.ts: `/docs` behind the optional deployment prefix.
const prefix = (process.env.MARVIS_BASE_PATH ?? "")
  .trim()
  .replace(/^\/+|\/+$/g, "");
const basePath = `${prefix ? `/${prefix}` : ""}/docs`;

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Inline the prefix into the bundles; lib/base-path.ts reads it.
  env: { MARVIS_BASE_PATH: prefix ? `/${prefix}` : "" },
  ...(process.env.STANDALONE === "true" ? { output: "standalone" } : {}),
  basePath,
  // Visiting http://host/ (outside basePath) would otherwise 404 — redirect
  // to the docs root. basePath: false makes the source and destination
  // literal (not re-prefixed with the basePath), so the redirect runs before
  // basePath routing kicks in.
  async redirects() {
    return [
      {
        source: "/",
        destination: basePath,
        basePath: false,
        permanent: false,
      },
      {
        source: "/zh/getting-started/cloud-quickstart",
        destination: "/zh/cloud-quickstart",
        permanent: true,
      },
      {
        source: "/zh/getting-started/self-hosting",
        destination: "/zh/self-host-quickstart",
        permanent: true,
      },
      {
        source: "/zh/guides/quickstart",
        destination: "/zh/cloud-quickstart",
        permanent: true,
      },
      {
        source: "/zh/guides/agents",
        destination: "/zh/agents",
        permanent: true,
      },
      {
        source: "/zh/cli/installation",
        destination: "/zh/cli",
        permanent: true,
      },
      {
        source: "/zh/cli/reference",
        destination: "/zh/cli",
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
