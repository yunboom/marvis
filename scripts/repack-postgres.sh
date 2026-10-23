#!/usr/bin/env bash
set -euo pipefail

# Repackages a zonky embedded-postgres-binaries jar from Maven Central into the
# PostgreSQL bundle the desktop app downloads for standalone mode:
#
#   marvis-postgres-<pg-version>-<os>-<arch>.tar.xz   bin/ lib/ share/
#
# plus a `.sha256` file. zonky's macOS jars expand symlinks into full copies
# (the ICU data three times over), so on non-Windows targets files of 1 KiB or
# more with identical content become relative symlinks to the first copy.
# Windows keeps copies because its extractor may not create symlinks.
#
# ZONKY_JAR points at a local jar instead of downloading (tests).

usage() {
  echo "usage: $0 <zonky-platform> <pg-version> <os-arch> <outdir>" >&2
  echo "  e.g. $0 darwin-arm64v8 17.11.0 darwin-arm64 dist" >&2
  exit 2
}

[ "$#" -eq 4 ] || usage

zonky_platform=$1
pg_version=$2
target=$3
out_dir=$4

hash_file() {
  local algo=$1 file=$2
  if command -v "sha${algo}sum" >/dev/null 2>&1; then
    "sha${algo}sum" "$file" | awk '{print $1}'
  else
    shasum -a "$algo" "$file" | awk '{print $1}'
  fi
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

jar="${ZONKY_JAR:-}"
if [ -z "$jar" ]; then
  base="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-${zonky_platform}/${pg_version}"
  name="embedded-postgres-binaries-${zonky_platform}-${pg_version}.jar"
  jar="$work/$name"
  curl -fsSL -o "$jar" "$base/$name"
  expected_sha1="$(curl -fsSL "$base/$name.sha1" | awk '{print $1}')"
  [ "$(hash_file 1 "$jar")" = "$expected_sha1" ] || {
    echo "checksum mismatch for $name" >&2
    exit 1
  }
fi

mkdir -p "$work/jar" "$work/tree"
unzip -q "$jar" -d "$work/jar"
txz="$(find "$work/jar" -maxdepth 1 -name '*.txz' | head -n 1)"
[ -n "$txz" ] || {
  echo "no .txz inside $jar" >&2
  exit 1
}
tar -xJf "$txz" -C "$work/tree"
chmod 755 "$work/tree"

case "$target" in
  windows-*) ;;
  *)
    python3 -I - "$work/tree" <<'PY'
import hashlib
import os
import sys

root = sys.argv[1]
first = {}
for dirpath, dirnames, filenames in os.walk(root):
    dirnames.sort()
    for name in sorted(filenames):
        path = os.path.join(dirpath, name)
        if os.path.islink(path) or os.path.getsize(path) < 1024:
            continue
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        if digest not in first:
            first[digest] = path
            continue
        target = os.path.relpath(first[digest], dirpath)
        os.remove(path)
        os.symlink(target, path)
PY
    ;;
esac

if tar --version 2>/dev/null | grep -q "GNU tar"; then
  tar_flags=(--owner=0 --group=0 --numeric-owner)
  export XZ_OPT=-9
else
  tar_flags=(--uid 0 --gid 0 --numeric-owner --options xz:compression-level=9)
fi

mkdir -p "$out_dir"
archive_name="marvis-postgres-${pg_version}-${target}.tar.xz"
archive="$(cd "$out_dir" && pwd)/$archive_name"
entries=()
for entry in "$work/tree"/*; do
  entries+=("$(basename "$entry")")
done
COPYFILE_DISABLE=1 tar "${tar_flags[@]}" -cJf "$archive" -C "$work/tree" "${entries[@]}"
echo "$(hash_file 256 "$archive")  $archive_name" >"$out_dir/${archive_name}.sha256"

echo "$archive"
