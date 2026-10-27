#!/usr/bin/env python3
"""Rebrand tracked files from Multica to Marvis, in place.

Run from the repository root after merging upstream (multica-ai/multica):

    python3 scripts/rebrand-marvis.py

It rewrites every tracked text file and renames every tracked path whose name
contains the old brand, preserving case: multica -> marvis, Multica -> Marvis,
MULTICA -> MARVIS. "multicast" is a different word and is left alone. The run
is idempotent, so running it on an already rebranded tree changes nothing.

A second pass points repository links at this fork (github.com/yunboom/marvis)
and moves the machine-level identifiers that the installed Tencent
Marvis.app already owns onto "marvis-studio" / "Marvis Studio": the home
directory (~/.marvis), the desktop deep-link scheme (marvis://), and the
packaged desktop app name (which is also its .app bundle name and userData
directory). Task working-directory markers such as .marvis/project/ are not
machine-level and keep the brand name.

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
    "server/migrations/648_rebrand_marvis.up.sql",
    "server/migrations/648_rebrand_marvis.down.sql",
}


# This fork lives at github.com/yunboom/marvis. Point the main repository (Go
# module path, clone / issue / release / raw-install URLs), the images and
# chart its CI publishes, the Homebrew tap, the release-job owner guard, and the
# desktop update feed at it. Other upstream
# repositories (marvis-cli, dsh-marvis-runtime) and npm packages do not exist
# under this owner and keep their names.
FORK_RULES = [
    (re.compile(r"marvis-ai/marvis(?![\w-])"), "yunboom/marvis"),
    # The same path escaped inside a regular-expression literal.
    (re.compile(r"marvis-ai\\/marvis(?![\w-])"), r"yunboom\\/marvis"),
    (re.compile(r"ghcr\.io/marvis-ai/"), "ghcr.io/yunboom/"),
    (re.compile(r"^(\s*owner: )marvis-ai$", re.M), r"\1yunboom"),
    (re.compile(r"marvis-ai/(tap\b|homebrew-tap)"), r"yunboom/\1"),
    (re.compile(r"repository_owner == 'marvis-ai'"), "repository_owner == 'yunboom'"),
]


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


def apply_studio_rules() -> int:
    changed = 0
    for path in git("grep", "-Il", "-e", "marvis", "-e", "Marvis").splitlines():
        if path in KEEP:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                source = f.read()
        except UnicodeDecodeError:
            continue
        result = source
        for pattern, replacement in FORK_RULES:
            result = pattern.sub(replacement, result)
        if result != source:
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
    studio = apply_studio_rules()
    print(f"rewrote {files} files, renamed {paths} paths, applied fork-specific identifiers to {studio} files")


if __name__ == "__main__":
    main()
