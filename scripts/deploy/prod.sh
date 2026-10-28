#!/usr/bin/env bash
# Deploy origin/main to production (the prototype host behind `ssh j`).
#
#   scripts/deploy/prod.sh           deploy
#   scripts/deploy/prod.sh --check   run every guard and the server's
#                                    preconditions without changing anything
#
# Only the tip of origin/main can be deployed, and only once its CI passed.
# server.sh repeats the main check on the host, so editing this file cannot
# get anything else deployed.
set -euo pipefail

readonly REPO_SLUG=yunboom/marvis
readonly CI_WORKFLOW=CI

info() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

mode=""
case "${1:-}" in
  "") ;;
  --check) mode="--check" ;;
  *) die "usage: scripts/deploy/prod.sh [--check]" ;;
esac

cd "$(git rev-parse --show-toplevel)"

command -v expect >/dev/null || die "expect is required"
command -v gh >/dev/null || die "gh is required to read CI results (brew install gh, then gh auth login)"

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "only main can be deployed; current branch is $branch"
[ -z "$(git status --porcelain)" ] || die "working tree has uncommitted changes"

git fetch -q origin main
sha="$(git rev-parse HEAD)"
main="$(git rev-parse origin/main)"
[ "$sha" = "$main" ] || die "HEAD $sha is not origin/main $main; pull or push first"
info "deploying origin/main $sha"

# The gate is the CI run that the push to main triggered. The nightly
# scheduled run tests the same commit with a wider scope and is not the gate:
# a nightly failure says nothing about whether this merge was green.
run="$(gh run list --repo "$REPO_SLUG" --commit "$sha" --workflow "$CI_WORKFLOW" \
  --event push --limit 1 --json status,conclusion,url \
  --jq '.[0] // empty | [.status, .conclusion, .url] | @tsv')"
[ -n "$run" ] || die "no $CI_WORKFLOW run from the push of $sha to main yet"

IFS=$'\t' read -r run_status run_conclusion run_url <<< "$run"
[ "$run_status" = "completed" ] || die "$CI_WORKFLOW is still running for $sha: $run_url"
[ "$run_conclusion" = "success" ] || die "$CI_WORKFLOW did not pass for $sha ($run_conclusion): $run_url"
info "$CI_WORKFLOW passed for $sha: $run_url"

exec expect "$(dirname "$0")/jump.exp" "$sha" ${mode:+"$mode"}
