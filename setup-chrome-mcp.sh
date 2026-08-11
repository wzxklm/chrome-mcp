#!/usr/bin/env bash
set -Eeuo pipefail

# Installs Chrome/Xvfb, MCP dependencies, and profile directories.
# MCP client registration remains a separate manual step.

MCP_SETUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MCP_SERVER_DIR="$MCP_SETUP_DIR"
MCP_SERVER_ENTRY="$MCP_SETUP_DIR/src/server.js"
MCP_SYSTEMD_DIR="$MCP_SETUP_DIR/systemd"
MCP_DEFAULT_PROFILE_INPUT="${CHROME_DEFAULT_PROFILE_DIR:-${CHROME_USER_DATA_DIR:-${HOME}/.chrome-profile}}"
MCP_PROFILES_INPUT="${CHROME_PROFILES_DIR:-${HOME}/.chrome-profiles}"
MCP_DISPLAY=":99"

if [[ $EUID -eq 0 ]]; then
  MCP_SUDO=()
else
  command -v sudo >/dev/null 2>&1 || {
    echo "ERROR: sudo is required when not running as root." >&2
    exit 1
  }
  MCP_SUDO=(sudo)
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: required command not found: $1" >&2
    exit 1
  }
}

path_contains() {
  local parent="$1"
  local candidate="$2"
  [[ "$candidate" == "$parent" || "$candidate" == "$parent/"* ]]
}

assert_no_symlink_components() {
  local path="$1"
  local label="$2"
  local current="$path"
  while [[ "$current" != "/" ]]; do
    [[ ! -L "$current" ]] || {
      echo "ERROR: $label must not contain symbolic links: $current" >&2
      exit 1
    }
    current="$(dirname -- "$current")"
  done
}

validate_profile_root() {
  local name="$1"
  local original="$2"
  local path="$3"

  [[ "$original" == /* ]] || {
    echo "ERROR: $name must be an absolute path." >&2
    exit 1
  }
  if [[ "$path" == "/" || "$(dirname -- "$path")" == "/" || "$path" == "$MCP_HOME_DIR" ]]; then
    echo "ERROR: $name points to a broad or dangerous directory: $path" >&2
    exit 1
  fi
  if path_contains "$path" "$MCP_SETUP_DIR" || path_contains "$MCP_SETUP_DIR" "$path"; then
    echo "ERROR: $name must not overlap the project directory: $path" >&2
    exit 1
  fi
  [[ ! -e "$path" || -d "$path" ]] || {
    echo "ERROR: $name must point to a directory: $path" >&2
    exit 1
  }
  assert_no_symlink_components "$path" "$name"
}

require_command dpkg
require_command realpath
MCP_HOME_DIR="$(realpath -m -s -- "$HOME")"
MCP_DEFAULT_PROFILE_DIR="$(realpath -m -s -- "$MCP_DEFAULT_PROFILE_INPUT")"
MCP_PROFILES_DIR="$(realpath -m -s -- "$MCP_PROFILES_INPUT")"
validate_profile_root CHROME_DEFAULT_PROFILE_DIR \
  "$MCP_DEFAULT_PROFILE_INPUT" "$MCP_DEFAULT_PROFILE_DIR"
validate_profile_root CHROME_PROFILES_DIR \
  "$MCP_PROFILES_INPUT" "$MCP_PROFILES_DIR"
if path_contains "$MCP_DEFAULT_PROFILE_DIR" "$MCP_PROFILES_DIR" || \
  path_contains "$MCP_PROFILES_DIR" "$MCP_DEFAULT_PROFILE_DIR"; then
  echo "ERROR: CHROME_DEFAULT_PROFILE_DIR and CHROME_PROFILES_DIR must not overlap." >&2
  exit 1
fi

if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "ERROR: google-chrome-stable installation is supported only on amd64." >&2
  exit 1
fi

for file in \
  "$MCP_SERVER_ENTRY" \
  "$MCP_SERVER_DIR/package.json" \
  "$MCP_SERVER_DIR/package-lock.json" \
  "$MCP_SYSTEMD_DIR/chrome-xvfb.service"; do
  [[ -f "$file" ]] || {
    echo "ERROR: required project file not found: $file" >&2
    exit 1
  }
done

echo "Installing system prerequisites..."
"${MCP_SUDO[@]}" apt-get update
"${MCP_SUDO[@]}" apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg util-linux

require_command curl
require_command gpg

MCP_SETUP_TMP_DIR="$(mktemp -d)"
trap 'rm -rf -- "$MCP_SETUP_TMP_DIR"' EXIT

MCP_INSTALL_NODE=0
if ! command -v node >/dev/null 2>&1 || \
  ! command -v npm >/dev/null 2>&1 || \
  ! node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' \
    >/dev/null 2>&1; then
  MCP_INSTALL_NODE=1
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor > "$MCP_SETUP_TMP_DIR/nodesource.gpg"
  "${MCP_SUDO[@]}" install -m 0644 \
    "$MCP_SETUP_TMP_DIR/nodesource.gpg" \
    /usr/share/keyrings/nodesource.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    | "${MCP_SUDO[@]}" tee /etc/apt/sources.list.d/nodesource.list >/dev/null
fi

curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
  | gpg --dearmor > "$MCP_SETUP_TMP_DIR/google-chrome.gpg"
"${MCP_SUDO[@]}" install -m 0644 \
  "$MCP_SETUP_TMP_DIR/google-chrome.gpg" \
  /usr/share/keyrings/google-chrome.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
  | "${MCP_SUDO[@]}" tee /etc/apt/sources.list.d/google-chrome.list >/dev/null

"${MCP_SUDO[@]}" apt-get update
MCP_RUNTIME_PACKAGES=(
  google-chrome-stable
  xvfb
  fonts-liberation
  fonts-noto-color-emoji
)
if [[ "$MCP_INSTALL_NODE" == "1" ]]; then
  MCP_RUNTIME_PACKAGES+=(nodejs)
fi
"${MCP_SUDO[@]}" apt-get install -y --no-install-recommends \
  "${MCP_RUNTIME_PACKAGES[@]}"

require_command node
require_command npm
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || {
  echo "ERROR: Node.js 20 or newer is required." >&2
  exit 1
}

echo "Installing locked MCP dependencies..."
npm --prefix "$MCP_SERVER_DIR" ci --omit=dev
node --check "$MCP_SERVER_ENTRY"

echo "Preparing browser profile directories..."
mkdir -p -- "$MCP_DEFAULT_PROFILE_DIR" "$MCP_PROFILES_DIR"
chmod 0700 -- "$MCP_DEFAULT_PROFILE_DIR" "$MCP_PROFILES_DIR"

echo "Installing the Xvfb systemd service..."
"${MCP_SUDO[@]}" install -m 0644 \
  "$MCP_SYSTEMD_DIR/chrome-xvfb.service" \
  /etc/systemd/system/chrome-xvfb.service
"${MCP_SUDO[@]}" systemctl daemon-reload
"${MCP_SUDO[@]}" systemctl enable --now chrome-xvfb.service

systemctl is-active --quiet chrome-xvfb.service
[[ -S /tmp/.X11-unix/X99 ]] || {
  echo "ERROR: Xvfb socket /tmp/.X11-unix/X99 was not created." >&2
  exit 1
}

echo "Chrome: $(google-chrome-stable --version)"
echo "Node: $(node --version)"
echo "Xvfb: active on $MCP_DISPLAY"
echo "Default profile: $MCP_DEFAULT_PROFILE_DIR"
echo "Named profiles: $MCP_PROFILES_DIR"
if [[ $EUID -eq 0 ]]; then
  echo "WARNING: Chrome MCP should normally run as a non-root user so Chrome can keep its sandbox enabled." >&2
fi
echo "Chrome MCP runtime setup completed. Register the MCP manually in your client."
