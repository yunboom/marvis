#!/usr/bin/env bash
set -euo pipefail

# The desktop app's standalone mode downloads this bundle, runs `migrate up`
# next to it and then starts `server`, the same order docker/entrypoint.sh
# uses. migrations.ResolveDir only finds the SQL when `migrations/` sits beside
# the binaries, so the layout below is a contract with the desktop app.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "$1" >&2
  exit 1
}

out_dir="$(mktemp -d)"
extract_dir="$(mktemp -d)"
trap 'rm -rf "$out_dir" "$extract_dir"' EXIT

# Missing arguments print usage and exit 2.
set +e
bash scripts/build-standalone-bundle.sh >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "expected exit 2 without arguments, got $status"

goos="$(go env GOOS)"
goarch="$(go env GOARCH)"
version="0.0.0-test"
bash scripts/build-standalone-bundle.sh "$goos" "$goarch" "$version" "$out_dir" >/dev/null

archive="$out_dir/marvis-server-${version}-${goos}-${goarch}.tar.xz"
[ -f "$archive" ] || fail "expected $archive"
[ -f "${archive}.sha256" ] || fail "expected ${archive}.sha256"

expected_sha="$(awk '{print $1}' "${archive}.sha256")"
actual_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
[ "$expected_sha" = "$actual_sha" ] || fail "checksum file does not match the archive"

tar -xJf "$archive" -C "$extract_dir"
exe=""
[ "$goos" = "windows" ] && exe=".exe"
[ -x "$extract_dir/server${exe}" ] || fail "server${exe} missing or not executable"
[ -x "$extract_dir/migrate${exe}" ] || fail "migrate${exe} missing or not executable"
[ -f "$extract_dir/migrations/001_init.up.sql" ] || fail "migrations/001_init.up.sql missing"

want_count="$(find server/migrations -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
got_count="$(find "$extract_dir/migrations" -maxdepth 1 -name '*.sql' | wc -l | tr -d ' ')"
[ "$want_count" = "$got_count" ] || fail "expected $want_count migration files, got $got_count"

grep -aq "$version" "$extract_dir/server${exe}" || fail "server binary does not carry version $version"

echo "build-standalone-bundle: ok"
