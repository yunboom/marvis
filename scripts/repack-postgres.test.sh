#!/usr/bin/env bash
set -euo pipefail

# The desktop app's standalone mode downloads the PostgreSQL bundle that
# scripts/repack-postgres.sh produces. zonky's macOS jars expand symlinks into
# copies (the ICU data three times over), so the repack replaces identical files
# with relative symlinks; Windows keeps copies because its extractor may not
# create symlinks. This test feeds the script a fake jar through ZONKY_JAR.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "$1" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A fake zonky tree: lib/libicudata.dylib is duplicated as two version aliases.
mkdir -p "$work/tree/bin" "$work/tree/lib" "$work/tree/share"
printf 'initdb' >"$work/tree/bin/initdb"
chmod 755 "$work/tree/bin/initdb"
head -c 4096 /dev/urandom >"$work/tree/lib/libicudata.68.2.dylib"
cp "$work/tree/lib/libicudata.68.2.dylib" "$work/tree/lib/libicudata.68.dylib"
cp "$work/tree/lib/libicudata.68.2.dylib" "$work/tree/lib/libicudata.dylib"
printf 'small' >"$work/tree/share/a.sql"
printf 'small' >"$work/tree/share/b.sql"
(cd "$work/tree" && tar -cJf "$work/postgres-fake.txz" .)
(cd "$work" && zip -q fake.jar postgres-fake.txz)

repack() {
  ZONKY_JAR="$work/fake.jar" bash scripts/repack-postgres.sh fake 17.11.0 "$1" "$work/out" >/dev/null
}

check_archive() {
  local archive=$1
  [ -f "$archive" ] || fail "expected $archive"
  [ -f "${archive}.sha256" ] || fail "expected ${archive}.sha256"
  local expected actual
  expected="$(awk '{print $1}' "${archive}.sha256")"
  actual="$( (command -v sha256sum >/dev/null && sha256sum "$archive" || shasum -a 256 "$archive") | awk '{print $1}')"
  [ "$expected" = "$actual" ] || fail "checksum file does not match $archive"
  if tar -tJf "$archive" | grep -Eq '^\./|(^|/)\._'; then
    fail "$archive carries ./ or ._* entries"
  fi
}

# Missing arguments print usage and exit 2.
set +e
bash scripts/repack-postgres.sh >/dev/null 2>&1
status=$?
set -e
[ "$status" -eq 2 ] || fail "expected exit 2 without arguments, got $status"

repack darwin-arm64
archive="$work/out/marvis-postgres-17.11.0-darwin-arm64.tar.xz"
check_archive "$archive"
mkdir -p "$work/x"
tar -xJf "$archive" -C "$work/x"
[ -x "$work/x/bin/initdb" ] || fail "bin/initdb lost its executable bit"
links="$(find "$work/x/lib" -type l | wc -l | tr -d ' ')"
[ "$links" = "2" ] || fail "expected 2 symlinked libicudata copies, got $links"
for f in libicudata.68.2.dylib libicudata.68.dylib libicudata.dylib; do
  cmp -s "$work/tree/lib/libicudata.68.2.dylib" "$work/x/lib/$f" || fail "lib/$f content changed"
done
find "$work/x" -type l -exec readlink {} \; | grep -q '^/' && fail "symlinks must be relative"
# Files below the size threshold stay as copies.
[ ! -L "$work/x/share/a.sql" ] && [ ! -L "$work/x/share/b.sql" ] || fail "small files must not be symlinked"

repack windows-amd64
win="$work/out/marvis-postgres-17.11.0-windows-amd64.tar.xz"
check_archive "$win"
if tar -tvJf "$win" | grep -q '^l'; then
  fail "windows bundle must not contain symlinks"
fi

echo "repack-postgres: ok"
