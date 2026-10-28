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
# Check runs that finished like this do not block a deploy.
readonly CI_PASSING_CONCLUSIONS="success skipped neutral"

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

runs="$(gh api --paginate "repos/$REPO_SLUG/commits/$sha/check-runs" \
  --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv')"
[ -n "$runs" ] || die "no CI runs found for $sha yet"

pending="$(printf '%s\n' "$runs" | awk -F'\t' '$2 != "completed" {print "  " $1}')"
[ -z "$pending" ] || die "CI is still running for $sha:
$pending"

failed="$(printf '%s\n' "$runs" | awk -F'\t' -v ok="$CI_PASSING_CONCLUSIONS" '
  BEGIN { n = split(ok, list, " "); for (i = 1; i <= n; i++) pass[list[i]] = 1 }
  !($3 in pass) {print "  " $1 " (" $3 ")"}')"
[ -z "$failed" ] || die "CI did not pass for $sha:
$failed"
info "CI passed for $sha"

exec expect "$(dirname "$0")/jump.exp" "$sha" ${mode:+"$mode"}
