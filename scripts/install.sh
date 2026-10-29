#!/usr/bin/env bash
# Marvis installer — installs the CLI and optionally provisions a self-host server.
#
# Install / upgrade CLI only:
#   curl -fsSL https://raw.githubusercontent.com/yunboom/marvis/main/scripts/install.sh | bash
#
# Install CLI + provision self-host server:
#   curl -fsSL https://raw.githubusercontent.com/yunboom/marvis/main/scripts/install.sh | bash -s -- --with-server
#
# After installation, run `marvis setup` to configure your environment.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
REPO_URL="https://github.com/yunboom/marvis.git"
REPO_WEB_URL="https://github.com/yunboom/marvis"  # without .git, for GitHub web APIs
INSTALL_DIR="${MARVIS_INSTALL_DIR:-$HOME/.marvis/server}"
BREW_TAP="yunboom/tap"
BREW_PACKAGE="$BREW_TAP/marvis"
# The formula the tap would install. Probing it first keeps a missing tap
# repository from costing a slow `brew tap` and a page of unrelated output.
BREW_FORMULA_URL="https://raw.githubusercontent.com/yunboom/homebrew-tap/main/Formula/marvis.rb"

# Host ports Compose reported after `up -d`; set by setup_server and reused by
# the summary so the health check and the printed URLs cannot diverge.
SELFHOST_BACKEND_PORT=""
SELFHOST_FRONTEND_PORT=""

# Colors (disabled when not a terminal)
if [ -t 1 ] || [ -t 2 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${BOLD}${CYAN}==> %s${RESET}\n" "$*"; }
ok()    { printf "${BOLD}${GREEN}✓ %s${RESET}\n" "$*"; }
warn()  { printf "${BOLD}${YELLOW}⚠ %s${RESET}\n" "$*" >&2; }
fail()  { printf "${BOLD}${RED}✗ %s${RESET}\n" "$*" >&2; exit 1; }

command_exists() { command -v "$1" >/dev/null 2>&1; }

running_in_ssh_session() {
  [ -n "${SSH_CONNECTION:-}" ] || [ -n "${SSH_CLIENT:-}" ] || [ -n "${SSH_TTY:-}" ]
}

print_remote_server_token_hint() {
  if ! running_in_ssh_session; then
    return
  fi

  printf "  ${BOLD}Looks like a remote/SSH session.${RESET} Browser login may not be able to call back to this machine's localhost.\n"
  printf "  Token login is usually simpler here:\n"
  printf "     1. On your local computer, open ${CYAN}https://marvis.ai/settings?tab=tokens${RESET}\n"
  printf "        and create a token under ${BOLD}Settings > API Tokens${RESET}.\n"
  printf "     2. On this server, run:\n"
  printf "        ${CYAN}marvis login --token <YOUR_TOKEN>${RESET}\n"
  printf "        ${CYAN}marvis daemon start${RESET}\n"
  printf "\n"
}

# Host port Docker Compose actually published for a service.
#
# This is the only authority. Compose's interpolation gives the calling process
# environment precedence over .env, so an ambient PORT / BACKEND_PORT / API_PORT
# / SERVER_PORT / FRONTEND_PORT moves the published port without touching the
# file. Re-deriving the port from .env alone made the installer probe and print
# a port the stack was never published on (#6145). Must be called from the
# installation directory, after `up -d`.
compose_published_port() {
  local service=$1 container_port=$2 published

  published="$(docker compose -f docker-compose.selfhost.yml port "$service" "$container_port" 2>/dev/null | tail -n 1)"
  published="${published##*:}"
  published="${published%$'\r'}"

  case "$published" in
    "" | *[!0-9]*) return 1 ;;
  esac

  printf "%s" "$published"
}

detect_os() {
  case "$(uname -s)" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
            fail "This script does not support Windows. Use the PowerShell installer instead:
  irm https://raw.githubusercontent.com/yunboom/marvis/main/scripts/install.ps1 | iex" ;;
    *)      fail "Unsupported operating system: $(uname -s). Marvis supports macOS, Linux, and Windows." ;;
  esac

  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  ARCH="amd64" ;;
    aarch64) ARCH="arm64" ;;
    arm64)   ARCH="arm64" ;;
    *)       fail "Unsupported architecture: $ARCH" ;;
  esac
}

# ---------------------------------------------------------------------------
# CLI Installation
# ---------------------------------------------------------------------------
_dump_brew_log() {
  local log="$1"
  if [ -s "$log" ]; then
    warn "Homebrew output (last 80 lines):"
    tail -n 80 "$log" | sed 's/^/  /' >&2
  fi
}

brew_tap_available() {
  curl -fsSL --max-time 15 -o /dev/null "$BREW_FORMULA_URL" 2>/dev/null
}

install_cli_brew() {
  if ! brew_tap_available; then
    info "Homebrew tap $BREW_TAP is not published. Installing from GitHub Releases instead."
    return 1
  fi

  info "Installing Marvis CLI via Homebrew..."
  local brew_log
  brew_log=$(mktemp)
  # Auto-update before tap/install prints every new upstream formula and cask,
  # which buries the actual failure in the diagnostic tail.
  export HOMEBREW_NO_AUTO_UPDATE=1
  if ! brew tap "$BREW_TAP" >"$brew_log" 2>&1; then
    warn "Failed to add Homebrew tap. Falling back to GitHub Releases binary install."
    _dump_brew_log "$brew_log"
    rm -f "$brew_log"
    return 1
  fi
  # brew install exits non-zero if already installed on older Homebrew versions
  if ! brew install "$BREW_PACKAGE" >"$brew_log" 2>&1; then
    if brew list "$BREW_PACKAGE" >/dev/null 2>&1; then
      rm -f "$brew_log"
      ok "Marvis CLI already installed via Homebrew"
    else
      warn "Failed to install marvis via Homebrew. Falling back to GitHub Releases binary install."
      _dump_brew_log "$brew_log"
      rm -f "$brew_log"
      return 1
    fi
  else
    rm -f "$brew_log"
    ok "Marvis CLI installed via Homebrew"
  fi
}

install_cli_binary() {
  info "Installing Marvis CLI from GitHub Releases..."

  local latest
  latest=$(get_latest_version)
  if [ -z "$latest" ]; then
    fail "Could not find a published Marvis release at $REPO_WEB_URL/releases. Check your network connection, or retry once a release is published."
  fi

  local version="${latest#v}"
  local url="https://github.com/yunboom/marvis/releases/download/${latest}/marvis-cli-${version}-${OS}-${ARCH}.tar.gz"
  local tmp_dir
  tmp_dir=$(mktemp -d)

  info "Downloading $url ..."
  if ! curl -fsSL "$url" -o "$tmp_dir/marvis.tar.gz"; then
    rm -rf "$tmp_dir"
    fail "Failed to download CLI binary."
  fi

  tar -xzf "$tmp_dir/marvis.tar.gz" -C "$tmp_dir" marvis

  # Try /usr/local/bin first, fall back to ~/.local/bin. Tests and scripted
  # installs can override the first choice with MARVIS_BIN_DIR.
  local bin_dir="${MARVIS_BIN_DIR:-/usr/local/bin}"
  if [ -w "$bin_dir" ]; then
    mv "$tmp_dir/marvis" "$bin_dir/marvis"
  elif command_exists sudo; then
    sudo mv "$tmp_dir/marvis" "$bin_dir/marvis"
  else
    bin_dir="$HOME/.local/bin"
    mkdir -p "$bin_dir"
    mv "$tmp_dir/marvis" "$bin_dir/marvis"
    chmod +x "$bin_dir/marvis"
    # Add to PATH if not already there
    if ! echo "$PATH" | tr ':' '\n' | grep -q "^$bin_dir$"; then
      export PATH="$bin_dir:$PATH"
      add_to_path "$bin_dir"
    fi
  fi

  rm -rf "$tmp_dir"
  ok "Marvis CLI installed to $bin_dir/marvis"
}

add_to_path() {
  local dir="$1"
  local line="export PATH=\"$dir:\$PATH\""
  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    if [ -f "$rc" ] && ! grep -qF "$dir" "$rc"; then
      printf '\n# Added by Marvis installer\n%s\n' "$line" >> "$rc"
    fi
  done
}

# Tag of the latest published release, or empty when there is none.
# Without a published release GitHub redirects /releases/latest to /releases,
# which has no tag segment; only a redirect to /releases/tag/<tag> counts.
get_latest_version() {
  local location
  # grep exits 1 when no match; use `|| true` to avoid triggering pipefail
  location=$(curl -sI "$REPO_WEB_URL/releases/latest" 2>/dev/null | grep -i '^location:' | tr -d '\r\n' || true)
  case "$location" in
    */releases/tag/*) printf '%s' "${location##*/releases/tag/}" ;;
  esac
}

get_selfhost_ref() {
  if [ -n "${MARVIS_SELFHOST_REF:-}" ]; then
    printf '%s' "$MARVIS_SELFHOST_REF"
    return
  fi

  local latest
  latest=$(get_latest_version)
  if [ -n "$latest" ]; then
    printf '%s' "$latest"
    return
  fi

  printf '%s' "main"
}

checkout_server_ref() {
  local ref="$1"

  if [ "$ref" = "main" ]; then
    git fetch origin main --depth 1 2>/dev/null || true
    git checkout --force main 2>/dev/null || true
    git reset --hard origin/main 2>/dev/null || true
    return
  fi

  git fetch origin --tags --force 2>/dev/null || true
  if git rev-parse --verify --quiet "refs/tags/$ref" >/dev/null; then
    git checkout --force "$ref" 2>/dev/null || git checkout --force "tags/$ref" 2>/dev/null || true
    return
  fi

  git fetch origin "$ref" --depth 1 2>/dev/null || true
  git checkout --force "$ref" 2>/dev/null || true
}

pull_official_selfhost_images() {
  if docker compose -f docker-compose.selfhost.yml pull; then
    return
  fi

  echo ""
  warn "Official images for the selected self-host channel are not published yet."
  echo "This can happen before the first GHCR release is available."
  echo "From $INSTALL_DIR, build from source instead:"
  echo "  docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml up -d --build"
  exit 1
}

upgrade_cli_brew() {
  info "Upgrading Marvis CLI via Homebrew..."
  brew update 2>/dev/null || true
  if brew upgrade "$BREW_PACKAGE" 2>/dev/null; then
    ok "Marvis CLI upgraded via Homebrew"
  else
    # brew upgrade exits non-zero if already up to date
    ok "Marvis CLI is already the latest version"
  fi
}

install_cli() {
  if command_exists marvis; then
    local current_ver
    # `marvis version` outputs "marvis 0.3.23 (commit: f46b929eb, built: 2026-06-16T10:11:56Z)" — extract just the version
    current_ver=$(marvis version 2>/dev/null | awk 'NR==1{print $2}' || echo "unknown")

    local latest_ver
    latest_ver=$(get_latest_version)

    # Normalize: strip leading 'v' for comparison
    local current_cmp="${current_ver#v}"
    local latest_cmp="${latest_ver#v}"

    if [ -z "$latest_ver" ] || [ "$current_cmp" = "$latest_cmp" ]; then
      ok "Marvis CLI is up to date ($current_ver)"
      return 0
    fi

    info "Marvis CLI $current_ver installed, latest is $latest_ver — upgrading..."
    if command_exists brew && brew list "$BREW_PACKAGE" >/dev/null 2>&1; then
      upgrade_cli_brew
    else
      install_cli_binary
    fi

    local new_ver
    new_ver=$(marvis version 2>/dev/null | awk 'NR==1{print $2}' || echo "unknown")
    ok "Marvis CLI upgraded ($current_ver → $new_ver)"
    return 0
  fi

  if command_exists brew; then
    install_cli_brew || install_cli_binary
  else
    install_cli_binary
  fi

  # Verify
  if ! command_exists marvis; then
    fail "CLI installed but 'marvis' not found on PATH. You may need to restart your shell."
  fi
}

# ---------------------------------------------------------------------------
# Docker check
# ---------------------------------------------------------------------------
check_docker() {
  if ! command_exists docker; then
    printf "\n"
    fail "Docker is not installed. Marvis self-hosting requires Docker and Docker Compose.

Install Docker:
  macOS:  https://docs.docker.com/desktop/install/mac-install/
  Linux:  https://docs.docker.com/engine/install/

After installing Docker, re-run this script with --with-server."
  fi

  if ! docker info >/dev/null 2>&1; then
    fail "Docker is installed but not running. Please start Docker and re-run this script."
  fi

  ok "Docker is available"
}

# ---------------------------------------------------------------------------
# Server setup (self-host / --with-server)
# ---------------------------------------------------------------------------
setup_server() {
  info "Setting up Marvis server..."
  local server_ref
  server_ref=$(get_selfhost_ref)
  info "Using self-host assets from ${server_ref}..."

  if [ -d "$INSTALL_DIR/.git" ]; then
    info "Updating existing installation at $INSTALL_DIR..."
    cd "$INSTALL_DIR"
  else
    info "Cloning Marvis repository..."
    if ! command_exists git; then
      fail "Git is not installed. Please install git and re-run."
    fi
    # Remove leftover directory from a previously interrupted clone
    if [ -d "$INSTALL_DIR" ]; then
      warn "Removing incomplete installation at $INSTALL_DIR..."
      rm -rf "$INSTALL_DIR"
    fi
    mkdir -p "$(dirname "$INSTALL_DIR")"
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  checkout_server_ref "$server_ref"

  ok "Repository ready at $INSTALL_DIR ($server_ref)"

  # Generate .env if needed
  if [ ! -f .env ]; then
    info "Creating .env with random secrets..."
    cp .env.example .env
    local jwt pgpass
    jwt=$(openssl rand -hex 32)
    pgpass=$(openssl rand -hex 24)
    if [ "$(uname -s)" = "Darwin" ]; then
      sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$jwt/" .env
      sed -i '' "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pgpass/" .env
      sed -i '' -E "s#^(DATABASE_URL=postgres://[^:]+:)[^@]*(@.*)#\1$pgpass\2#" .env
    else
      sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$jwt/" .env
      sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pgpass/" .env
      sed -i -E "s#^(DATABASE_URL=postgres://[^:]+:)[^@]*(@.*)#\1$pgpass\2#" .env
    fi
    ok "Generated .env with random JWT_SECRET and POSTGRES_PASSWORD"
  else
    ok "Using existing .env"
  fi

  # Start Docker Compose
  info "Pulling official Marvis images..."
  pull_official_selfhost_images
  info "Starting Marvis services (this may take a few minutes on first run)..."
  docker compose -f docker-compose.selfhost.yml up -d

  # Read the ports Compose actually published, once, and reuse them for both the
  # health check and the summary so the two can never disagree.
  if ! SELFHOST_BACKEND_PORT="$(compose_published_port backend 13840)"; then
    fail "Started the stack but could not read the backend host port from Docker Compose.
  Check it with: cd $INSTALL_DIR && docker compose -f docker-compose.selfhost.yml ps"
  fi
  if ! SELFHOST_FRONTEND_PORT="$(compose_published_port frontend 3000)"; then
    fail "Started the stack but could not read the frontend host port from Docker Compose.
  Check it with: cd $INSTALL_DIR && docker compose -f docker-compose.selfhost.yml ps"
  fi

  # Wait for health check
  info "Waiting for backend to be ready..."
  local ready=false
  for i in $(seq 1 45); do
    if curl -sf "http://localhost:${SELFHOST_BACKEND_PORT}/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 2
  done

  if [ "$ready" = true ]; then
    ok "Marvis server is running"
  else
    warn "Server is still starting. You can check logs with:"
    echo "  cd $INSTALL_DIR && docker compose -f docker-compose.selfhost.yml logs"
    echo ""
  fi
}


# ---------------------------------------------------------------------------
# Main: Default mode (install / upgrade CLI only)
# ---------------------------------------------------------------------------
run_default() {
  printf "\n"
  printf "${BOLD}  Marvis — Installer${RESET}\n"
  printf "\n"

  detect_os
  install_cli

  printf "\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  ✓ Marvis CLI is ready!${RESET}\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "\n"
  printf "  ${BOLD}Next: configure your environment${RESET}\n"
  printf "\n"
  printf "     ${CYAN}marvis setup${RESET}                # Connect to Marvis Cloud (marvis.ai)\n"
  printf "     ${CYAN}marvis setup self-host${RESET}       # Connect to a self-hosted server\n"
  printf "\n"
  print_remote_server_token_hint
  printf "  ${BOLD}Self-hosting?${RESET} Install the server first:\n"
  printf "     curl -fsSL https://raw.githubusercontent.com/yunboom/marvis/main/scripts/install.sh | bash -s -- --with-server\n"
  printf "\n"
}

# ---------------------------------------------------------------------------
# Main: With-server mode (provision self-host infrastructure + install CLI)
# ---------------------------------------------------------------------------
run_with_server() {
  printf "\n"
  printf "${BOLD}  Marvis — Self-Host Installer${RESET}\n"
  printf "  Provisioning server infrastructure + installing CLI\n"
  printf "\n"

  detect_os
  check_docker
  setup_server
  install_cli

  printf "\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "${BOLD}${GREEN}  ✓ Marvis server is running and CLI is ready!${RESET}\n"
  printf "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}\n"
  printf "\n"
  printf "  ${BOLD}Frontend:${RESET}  http://localhost:%s\n" "$SELFHOST_FRONTEND_PORT"
  printf "  ${BOLD}Backend:${RESET}   http://localhost:%s\n" "$SELFHOST_BACKEND_PORT"
  printf "  ${BOLD}Server at:${RESET} %s\n" "$INSTALL_DIR"
  printf "\n"
  printf "  ${BOLD}Next: configure your CLI to connect${RESET}\n"
  printf "\n"
  printf "     ${CYAN}marvis setup self-host${RESET}   # Configure + authenticate + start daemon\n"
  printf "\n"
  printf "  ${BOLD}Login:${RESET} configure ${CYAN}RESEND_API_KEY${RESET} in .env for email codes,\n"
  printf "  or read the generated code from backend logs when Resend is unset.\n"
  printf "\n"
  printf "  ${BOLD}To stop all services:${RESET}\n"
  printf "     curl -fsSL https://raw.githubusercontent.com/yunboom/marvis/main/scripts/install.sh | bash -s -- --stop\n"
  printf "\n"
}

# ---------------------------------------------------------------------------
# Stop: shut down a self-hosted installation
# ---------------------------------------------------------------------------
run_stop() {
  printf "\n"
  info "Stopping Marvis services..."

  if [ -d "$INSTALL_DIR" ]; then
    cd "$INSTALL_DIR"
    if [ -f docker-compose.selfhost.yml ]; then
      docker compose -f docker-compose.selfhost.yml down
      ok "Docker services stopped"
    else
      warn "No docker-compose.selfhost.yml found at $INSTALL_DIR"
    fi
  else
    warn "No Marvis installation found at $INSTALL_DIR"
  fi

  if command_exists marvis; then
    marvis daemon stop 2>/dev/null && ok "Daemon stopped" || true
  fi

  printf "\n"
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
main() {
  local mode="default"

  while [ $# -gt 0 ]; do
    case "$1" in
      --with-server) mode="with-server" ;;
      --local)       mode="with-server" ;;  # backwards compat alias
      --stop)        mode="stop" ;;
      --help|-h)
        echo "Usage: install.sh [--with-server | --stop]"
        echo ""
        echo "  (default)       Install / upgrade the Marvis CLI"
        echo "  --with-server   Install CLI + provision a self-host server (Docker)"
        echo "  --stop          Stop a self-hosted installation"
        echo ""
        echo "Environment variables:"
        echo "  MARVIS_INSTALL_DIR   Self-host server install directory"
        echo "                        (default: \$HOME/.marvis/server)"
        echo "  MARVIS_BIN_DIR       Target directory for the CLI binary when"
        echo "                        installing from GitHub Releases"
        echo "                        (default: /usr/local/bin, then \$HOME/.local/bin)"
        echo "  MARVIS_SELFHOST_REF  Git ref to check out for self-host assets"
        echo "                        (default: latest release tag, falling back to main)"
        echo ""
        echo "After installation, run 'marvis setup' to configure your environment."
        exit 0
        ;;
      *) warn "Unknown option: $1" ;;
    esac
    shift
  done

  case "$mode" in
    default)     run_default ;;
    with-server) run_with_server ;;
    stop)        run_stop ;;
  esac
}

main "$@"
