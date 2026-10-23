#!/usr/bin/env bash
set -euo pipefail

# Builds the server bundle that the desktop app downloads for standalone mode:
#
#   marvis-server-<version>-<os>-<arch>.tar.xz
#     server[.exe]     API server
#     migrate[.exe]    migration runner (the desktop app runs `migrate up` first)
#     migrations/      SQL files; migrations.ResolveDir finds them next to the binaries
#
# plus a `.sha256` file next to it. <os> is darwin/linux/windows and <arch> is
# amd64/arm64, the same names the CLI release assets use. COMMIT overrides the
# commit stamped into the server (defaults to the current short HEAD).

usage() {
  echo "usage: $0 <goos> <goarch> <version> <outdir>" >&2
  exit 2
}

# sha256_line prints "<hex>  <name>" for a file in the current directory.
sha256_line() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

[ "$#" -eq 4 ] || usage

goos=$1
goarch=$2
version=$3
out_dir=$4

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
commit="${COMMIT:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
exe=""
[ "$goos" = "windows" ] && exe=".exe"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"

(
  cd "$ROOT_DIR/server"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
    -ldflags "-s -w -X main.version=${version} -X main.commit=${commit}" -o "$staging/server${exe}" ./cmd/server
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
    -ldflags "-s -w" -o "$staging/migrate${exe}" ./cmd/migrate
)

mkdir -p "$staging/migrations"
cp "$ROOT_DIR"/server/migrations/*.sql "$staging/migrations/"

# Normalize ownership so the archive carries no builder uid or user name, and
# compress at xz level 9 (GNU tar pipes through xz, bsdtar uses liblzma).
if tar --version 2>/dev/null | grep -q "GNU tar"; then
  tar_flags=(--owner=0 --group=0 --numeric-owner)
  export XZ_OPT=-9
else
  tar_flags=(--uid 0 --gid 0 --numeric-owner --options xz:compression-level=9)
fi

mkdir -p "$out_dir"
archive_name="marvis-server-${version}-${goos}-${goarch}.tar.xz"
archive="$(cd "$out_dir" && pwd)/$archive_name"
# COPYFILE_DISABLE keeps macOS from adding ._* resource-fork entries.
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -cJf "$archive" -C "$staging" "server${exe}" "migrate${exe}" migrations
(cd "$out_dir" && sha256_line "$archive_name" >"${archive_name}.sha256")

echo "$archive"
