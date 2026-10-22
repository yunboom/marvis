#!/usr/bin/env python3
"""Rebrand tracked files from Multica to Marvis, in place.

Run from the repository root after merging upstream (multica-ai/multica):

    python3 scripts/rebrand-marvis.py

It rewrites every tracked text file and renames every tracked path whose name
contains the old brand, preserving case: multica -> marvis, Multica -> Marvis,
MULTICA -> MARVIS. "multicast" is a different word and is left alone. The run
is idempotent, so running it on an already rebranded tree changes nothing.

Files that must keep the old name verbatim (this script, the fork notes in
CLAUDE.md, and the migration that renames pre-rebrand database objects) are
listed in KEEP and skipped.
"""

import os
import re
import subprocess
import sys

PATTERN = re.compile(r"multica(?!st)", re.IGNORECASE)

KEEP = {
    "scripts/rebrand-marvis.py",
    "CLAUDE.md",
    "server/migrations/589_rebrand_marvis.up.sql",
    "server/migrations/589_rebrand_marvis.down.sql",
}


def replace(match: re.Match) -> str:
    word = match.group(0)
    if word.isupper():
        return "MARVIS"
    if word.islower():
        return "marvis"
    if word[0].isupper() and word[1:].islower():
        return "Marvis"
    return "".join(c.upper() if o.isupper() else c for c, o in zip("marvis", word))


def git(*args: str) -> str:
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def rewrite_contents() -> int:
    changed = 0
    for path in git("grep", "-Il", "-i", "multica").splitlines():
        if path in KEEP:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
        except UnicodeDecodeError:
            print(f"skip non-UTF-8 file: {path}", file=sys.stderr)
            continue
        result, count = PATTERN.subn(replace, source)
        if count:
            with open(path, "w", encoding="utf-8") as f:
                f.write(result)
            changed += 1
    return changed


def rename_paths() -> int:
    targets = set()
    for path in git("ls-files").splitlines():
        if path in KEEP:
            continue
        parts = path.split("/")
        for i, part in enumerate(parts):
            if PATTERN.search(part):
                targets.add("/".join(parts[: i + 1]))

    # Deepest first, so a directory is moved after everything inside it.
    renamed = 0
    for path in sorted(targets, key=lambda p: p.count("/"), reverse=True):
        head, tail = os.path.split(path)
        if os.path.exists(path):
            git("mv", path, os.path.join(head, PATTERN.sub(replace, tail)))
            renamed += 1
    return renamed


def main() -> None:
    files = rewrite_contents()
    paths = rename_paths()
    print(f"rewrote {files} files, renamed {paths} paths")


if __name__ == "__main__":
    main()
