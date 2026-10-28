#!/usr/bin/env bash
# Production deploy, run as root on the prototype host by scripts/deploy/jump.exp
# after it has checked the repo out at the tip of origin/main.
#
#   server.sh <commit>          build, back up, switch, health-check, roll back on failure
#   server.sh --check <commit>  run every precondition and change nothing
#
# The host runs CentOS 7 with git 1.8: no `git -C`, so every git call cds first.
set -euo pipefail

readonly APP_DIR=/root/apps/marvis
readonly REPO_DIR="$APP_DIR/repo"
readonly ENV_FILE="$APP_DIR/.env"
readonly BACKUP_DIR="$APP_DIR/backups"
readonly RELEASES_FILE="$APP_DIR/releases.log"
readonly LOCK_FILE="$APP_DIR/deploy.lock"
readonly BASE_PATH=/marvis
readonly KEEP_BACKUPS=10
readonly KEEP_RELEASES=3
readonly HEALTH_TIMEOUT_SECONDS=180
readonly BACKEND_IMAGE=marvis-backend
readonly WEB_IMAGE=marvis-web
readonly DOCS_IMAGE=marvis-docs

info() { printf '==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  die "usage: server.sh [--check] <40-char commit sha>"
}

# Last value of KEY in the production env file, or DEFAULT. The file may hold
# a multi-line PEM, so it is grepped rather than sourced.
env_value() {
  local key=$1 default=${2:-} value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$default}"
}

# Image names are fixed here rather than read from .env, so the tag is the only
# thing that varies between a deploy and a rollback.
compose() {
  MARVIS_BACKEND_IMAGE="$BACKEND_IMAGE" \
  MARVIS_WEB_IMAGE="$WEB_IMAGE" \
  MARVIS_DOCS_IMAGE="$DOCS_IMAGE" \
    docker compose --env-file "$ENV_FILE" -f "$REPO_DIR/docker-compose.selfhost.yml" --profile docs "$@"
}

last_release() {
  [ -f "$RELEASES_FILE" ] || return 0
  tail -n 1 "$RELEASES_FILE" | awk '{print $3}'
}

verify_main() {
  local sha=$1 main head
  cd "$REPO_DIR"
  git fetch -q origin main
  main="$(git rev-parse FETCH_HEAD)"
  head="$(git rev-parse HEAD)"
  [ "$sha" = "$main" ] || die "commit $sha is not the tip of origin/main ($main); sync main locally and retry"
  [ "$head" = "$sha" ] || die "repo is checked out at $head, expected $sha"
  info "commit $sha is the tip of origin/main"
}

# The config is the local .env.prod, which jump.exp uploads before this runs;
# a --check run only compares it, so the host may not have one yet.
ensure_env() {
  local check_only=$1
  if [ -f "$ENV_FILE" ]; then
    info "using $ENV_FILE"
    return 0
  fi
  [ "$check_only" = 1 ] || die "$ENV_FILE is missing; deploy with scripts/deploy/prod.sh, which uploads it"
  info "$ENV_FILE is not installed yet"
}

check_host() {
  command -v docker >/dev/null || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "docker compose plugin is not installed"
  command -v flock >/dev/null || die "flock is not installed"
  command -v curl >/dev/null || die "curl is not installed"
}

image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

build_images() {
  local sha=$1
  cd "$REPO_DIR"

  if image_exists "$BACKEND_IMAGE:$sha"; then
    info "$BACKEND_IMAGE:$sha already built"
  else
    info "building $BACKEND_IMAGE:$sha"
    docker build -f Dockerfile -t "$BACKEND_IMAGE:$sha" \
      --build-arg VERSION="$sha" --build-arg COMMIT="$sha" \
      --build-arg DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .
  fi

  if image_exists "$WEB_IMAGE:$sha"; then
    info "$WEB_IMAGE:$sha already built"
  else
    info "building $WEB_IMAGE:$sha"
    docker build -f Dockerfile.web -t "$WEB_IMAGE:$sha" \
      --build-arg NEXT_PUBLIC_APP_VERSION="$sha" \
      --build-arg NEXT_PUBLIC_BASE_PATH="$BASE_PATH" .
  fi

  if image_exists "$DOCS_IMAGE:$sha"; then
    info "$DOCS_IMAGE:$sha already built"
  else
    info "building $DOCS_IMAGE:$sha"
    docker build -f Dockerfile.docs -t "$DOCS_IMAGE:$sha" \
      --build-arg NEXT_PUBLIC_BASE_PATH="$BASE_PATH" .
  fi
}

# Migrations only move forward, so a dump taken before the switch is the only
# way back to the old schema. Nothing to dump before the first deploy.
backup_database() {
  local label=$1 running user db file
  running="$(compose ps --status running -q postgres 2>/dev/null || true)"
  if [ -z "$running" ]; then
    info "postgres is not running yet; skipping backup"
    return 0
  fi

  mkdir -p "$BACKUP_DIR"
  user="$(env_value POSTGRES_USER marvis)"
  db="$(env_value POSTGRES_DB marvis)"
  file="$BACKUP_DIR/$(date +%Y%m%d-%H%M%S)-${label:-initial}.dump"
  info "backing up database to $file"
  if ! compose exec -T postgres pg_dump -U "$user" -d "$db" -Fc > "$file"; then
    rm -f "$file"
    die "database backup failed; nothing was switched"
  fi
  LAST_BACKUP="$file"

  ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f || true
}

switch_to() {
  local tag=$1
  info "starting images tagged $tag"
  MARVIS_IMAGE_TAG="$tag" compose up -d
}

url_ok() {
  curl -fsSL -o /dev/null --max-time 5 "$1"
}

wait_healthy() {
  local bind backend web docs deadline
  bind="$(env_value MARVIS_BIND_ADDRESS 127.0.0.1)"
  backend="http://$bind:$(env_value PORT 13840)/readyz"
  web="http://$bind:$(env_value FRONTEND_PORT 3000)$BASE_PATH/login"
  docs="http://$bind:$(env_value DOCS_PORT 4000)$BASE_PATH/docs"
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))

  info "waiting for $backend, $web and $docs"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if url_ok "$backend" && url_ok "$web" && url_ok "$docs"; then
      info "all services healthy"
      return 0
    fi
    sleep 3
  done

  warn "services not healthy after ${HEALTH_TIMEOUT_SECONDS}s"
  compose ps || true
  compose logs --tail 50 backend frontend docs || true
  return 1
}

record_release() {
  printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$RELEASES_FILE"
}

# Keep the images of the last few successful releases for rollback and drop
# the rest, plus build cache older than a week: the root disk is small.
prune_images() {
  local keep repo tag
  keep="$(tail -n "$KEEP_RELEASES" "$RELEASES_FILE" | awk '{print $3}')"
  for repo in "$BACKEND_IMAGE" "$WEB_IMAGE" "$DOCS_IMAGE"; do
    docker image ls "$repo" --format '{{.Tag}}' | while read -r tag; do
      if ! printf '%s\n' "$keep" | grep -qx "$tag"; then
        docker image rm "$repo:$tag" >/dev/null 2>&1 || true
      fi
    done
  done
  docker image prune -f >/dev/null
  docker builder prune -f --filter until=168h >/dev/null
}

rollback() {
  local previous=$1
  if [ -z "$previous" ]; then
    warn "no earlier release to roll back to"
  elif ! image_exists "$BACKEND_IMAGE:$previous"; then
    warn "images for $previous are gone; cannot roll back"
  else
    warn "rolling back to $previous"
    switch_to "$previous"
    if wait_healthy; then
      warn "rolled back to $previous"
    else
      warn "rollback to $previous is unhealthy too"
    fi
  fi

  if [ -n "${LAST_BACKUP:-}" ]; then
    warn "the new release may have migrated the schema; if the old release misbehaves, restore $LAST_BACKUP (not done automatically)"
  fi
}

main() {
  local check_only=0 sha
  if [ "${1:-}" = "--check" ]; then
    check_only=1
    shift
  fi
  [ $# -eq 1 ] || usage
  sha=$1
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || usage
  [ "$(id -u)" -eq 0 ] || die "must run as root"

  mkdir -p "$APP_DIR"
  exec 9> "$LOCK_FILE"
  flock -n 9 || die "another deploy is running"

  check_host
  verify_main "$sha"
  ensure_env "$check_only"

  local previous
  previous="$(last_release)"
  if [ "$check_only" = 1 ]; then
    info "check passed; current release: ${previous:-none}"
    return 0
  fi
  if [ "$previous" = "$sha" ]; then
    info "$sha is already the current release; redeploying it"
  fi

  build_images "$sha"
  LAST_BACKUP=""
  backup_database "$previous"
  switch_to "$sha"

  if wait_healthy; then
    record_release "$sha"
    prune_images
    info "deployed $sha"
    return 0
  fi

  rollback "$previous"
  die "deploy of $sha failed"
}

main "$@"
