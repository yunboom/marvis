# Release runbook

## Normal release

Release from a reviewed commit on `main` by creating and pushing a new semantic
version tag such as `v0.18.4`. The Release workflow intentionally has no manual
trigger: a tag push is the only event that can publish binaries, Homebrew
formulae, and container images.

The verification job runs the Go tests and `govulncheck` before any publishing
job starts. The vulnerability scan is fail-closed by default.

The repository has immutable releases enabled: once a release is published, no
asset can be added or replaced, and its tag cannot be reused. GoReleaser
therefore creates a **draft**; the standalone bundles and the Linux, Windows
and macOS desktop installers upload into it, and the `publish` job publishes it
last, as latest for a stable tag. Publishing requires the standalone bundles to
succeed and waits for the desktop jobs to finish, but not for them to succeed;
an installer that failed can only go out with a new tag. The macOS installers
are unsigned (no Developer ID): CI ad-hoc signs them and skips notarization. If a run fails before `publish`, fix it
and rerun the failed jobs on the same tag; a tag whose release was already
published needs a new patch version.

CI and release jobs require Go `~1.27.3`: at least 1.27.3, while accepting
newer 1.27 patches. This security floor is independent of the development
minimum in `server/go.mod`. A plain `1.27.x` can resolve to an older patch
while the `setup-go` version manifest catches up with an official Go release.
When raising the security floor, update all Go workflows and the pinned
Go builder image in `Dockerfile` together so shipped binaries also receive
the fixes.

## Standalone-mode resources

The desktop app's standalone mode downloads a server bundle and a PostgreSQL
bundle, both listed in `server-manifest.json` on the latest release.

- **Server bundles** are built by the Release workflow's `standalone-bundles`
  job for every tag (`scripts/build-standalone-bundle.sh`, six platforms) and
  uploaded with `server-manifest.json`.
- **PostgreSQL bundles** change only when PostgreSQL is upgraded. Run the
  **PostgreSQL bundle** workflow once with the zonky version (e.g. `17.11.0`);
  it publishes `pg-<version>` with the repacked bundles and
  `postgres-manifest.json`. Then set the repository variable
  `STANDALONE_POSTGRES_VERSION` to that version before the next tag.
- Optional repository variables: `STANDALONE_MIRROR_BASE_URL` adds a mirror
  URL after each GitHub URL (the mirror must serve the same `<tag>/<file>`
  paths), and `STANDALONE_MIN_APP_VERSION` sets the oldest desktop app a
  release's bundles support (default `0.0.0`).

## Emergency vulnerability-scan bypass

Use the bypass only when `govulncheck` itself or its live vulnerability database
is unavailable, or when maintainers have documented a confirmed false positive
that blocks an urgent release. Never use it to publish a release with an
unresolved reachable vulnerability.

1. Record the reason and maintainer approval in the release issue or pull
   request, and confirm no other release is in progress.
2. In **Settings → Secrets and variables → Actions → Variables**, set the
   repository variable `ALLOW_VULN_BYPASS_FOR_TAG` to the exact release tag,
   for example `v0.18.4`.
3. Re-run the failed Release workflow for that tag. A different tag, an empty
   value, or any typo keeps the scan enabled.
4. Confirm the verification log contains the explicit bypass warning and retain
   the workflow URL in the incident record.
5. Delete `ALLOW_VULN_BYPASS_FOR_TAG` immediately after the release run
   completes. The tag-scoped value prevents a concurrent release with another
   tag from inheriting the bypass.

Every Go binary retains its compiler version in the standard Go build metadata;
use `go version -m <binary>` when auditing a downloaded release artifact.
