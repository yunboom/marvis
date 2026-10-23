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
# amd64/arm64, the same names the CLI release assets use.

usage() {
  echo "usage: $0 <goos> <goarch> <version> <outdir>" >&2
  exit 2
}

[ "$#" -eq 4 ] || usage

goos=$1
goarch=$2
version=$3
out_dir=$4

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exe=""
[ "$goos" = "windows" ] && exe=".exe"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

(
  cd "$ROOT_DIR/server"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
    -ldflags "-s -w -X main.version=${version}" -o "$staging/server${exe}" ./cmd/server
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath \
    -ldflags "-s -w" -o "$staging/migrate${exe}" ./cmd/migrate
)

mkdir -p "$staging/migrations"
cp "$ROOT_DIR"/server/migrations/*.sql "$staging/migrations/"

mkdir -p "$out_dir"
archive="$out_dir/marvis-server-${version}-${goos}-${goarch}.tar.xz"
tar -cf - -C "$staging" . | xz -9 -T0 >"$archive"
(cd "$out_dir" && shasum -a 256 "$(basename "$archive")" >"$(basename "$archive").sha256")

echo "$archive"
