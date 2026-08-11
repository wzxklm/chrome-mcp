#!/usr/bin/env bash
set -Eeuo pipefail

# Reuses an existing password by default. Set VNC_PASSWORD for first-time,
# non-interactive setup or RESET_VNC_PASSWORD=1 to replace an existing password.

MCP_SETUP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MCP_SYSTEMD_DIR="$MCP_SETUP_DIR/systemd"
MCP_VNC_CONFIG_DIR="/etc/chrome-mcp"
MCP_VNC_PASSWORD_FILE="$MCP_VNC_CONFIG_DIR/x11vnc.pass"
MCP_RESET_VNC_PASSWORD="${RESET_VNC_PASSWORD:-0}"

if [[ $EUID -eq 0 ]]; then
  MCP_SUDO=()
else
  command -v sudo >/dev/null 2>&1 || {
    echo "ERROR: sudo is required when not running as root." >&2
    exit 1
  }
  MCP_SUDO=(sudo)
fi

for file in \
  "$MCP_SYSTEMD_DIR/chrome-x11vnc.service" \
  "$MCP_SYSTEMD_DIR/chrome-novnc.service"; do
  [[ -f "$file" ]] || {
    echo "ERROR: required project file not found: $file" >&2
    exit 1
  }
done

[[ -f /etc/systemd/system/chrome-xvfb.service ]] || {
  echo "ERROR: chrome-xvfb.service is not installed. Run setup-chrome-mcp.sh first." >&2
  exit 1
}

MCP_WRITE_VNC_PASSWORD=0
if [[ ! -f "$MCP_VNC_PASSWORD_FILE" || "$MCP_RESET_VNC_PASSWORD" == "1" ]]; then
  MCP_WRITE_VNC_PASSWORD=1
  MCP_VNC_PASSWORD_VALUE="${VNC_PASSWORD:-}"
  if [[ -z "$MCP_VNC_PASSWORD_VALUE" ]]; then
    [[ -t 0 ]] || {
      echo "ERROR: set VNC_PASSWORD for non-interactive setup." >&2
      exit 1
    }
    read -r -s -p "VNC password: " MCP_VNC_PASSWORD_VALUE
    echo
    read -r -s -p "Confirm VNC password: " MCP_VNC_PASSWORD_CONFIRM
    echo
    [[ "$MCP_VNC_PASSWORD_VALUE" == "$MCP_VNC_PASSWORD_CONFIRM" ]] || {
      echo "ERROR: VNC passwords do not match." >&2
      exit 1
    }
    unset MCP_VNC_PASSWORD_CONFIRM
  fi
  [[ -n "$MCP_VNC_PASSWORD_VALUE" ]] || {
    echo "ERROR: VNC password must not be empty." >&2
    exit 1
  }
fi

echo "Installing VNC dependencies..."
"${MCP_SUDO[@]}" apt-get update
"${MCP_SUDO[@]}" apt-get install -y --no-install-recommends \
  iproute2 x11vnc novnc websockify

if [[ "$MCP_WRITE_VNC_PASSWORD" == "1" ]]; then
  MCP_VNC_TMP_DIR="$(mktemp -d)"
  trap 'rm -rf -- "$MCP_VNC_TMP_DIR"' EXIT
  x11vnc -storepasswd "$MCP_VNC_PASSWORD_VALUE" \
    "$MCP_VNC_TMP_DIR/x11vnc.pass" >/dev/null
  unset MCP_VNC_PASSWORD_VALUE VNC_PASSWORD
  "${MCP_SUDO[@]}" install -d -m 0755 "$MCP_VNC_CONFIG_DIR"
  "${MCP_SUDO[@]}" install -m 0600 \
    "$MCP_VNC_TMP_DIR/x11vnc.pass" "$MCP_VNC_PASSWORD_FILE"
else
  echo "Reusing existing VNC password file: $MCP_VNC_PASSWORD_FILE"
  "${MCP_SUDO[@]}" chmod 0600 "$MCP_VNC_PASSWORD_FILE"
fi

echo "Installing VNC systemd services..."
"${MCP_SUDO[@]}" install -m 0644 \
  "$MCP_SYSTEMD_DIR/chrome-x11vnc.service" \
  /etc/systemd/system/chrome-x11vnc.service
"${MCP_SUDO[@]}" install -m 0644 \
  "$MCP_SYSTEMD_DIR/chrome-novnc.service" \
  /etc/systemd/system/chrome-novnc.service
"${MCP_SUDO[@]}" systemctl daemon-reload
"${MCP_SUDO[@]}" systemctl enable \
  chrome-xvfb.service chrome-x11vnc.service chrome-novnc.service
"${MCP_SUDO[@]}" systemctl start chrome-xvfb.service
"${MCP_SUDO[@]}" systemctl restart chrome-x11vnc.service
"${MCP_SUDO[@]}" systemctl restart chrome-novnc.service

for service in chrome-xvfb chrome-x11vnc chrome-novnc; do
  systemctl is-active --quiet "$service.service" || {
    echo "ERROR: $service.service is not active." >&2
    exit 1
  }
done

MCP_LISTENERS="$(ss -lnt)"
grep -qE '127\.0\.0\.1:5900\b' <<< "$MCP_LISTENERS" || {
  echo "ERROR: x11vnc is not listening on 127.0.0.1:5900." >&2
  exit 1
}
grep -qE '127\.0\.0\.1:6080\b' <<< "$MCP_LISTENERS" || {
  echo "ERROR: noVNC is not listening on 127.0.0.1:6080." >&2
  exit 1
}

echo "VNC: 127.0.0.1:5900 (password protected)"
echo "noVNC: http://127.0.0.1:6080/vnc.html"
echo "Expose noVNC through an authenticated HTTPS reverse proxy when remote access is required."
echo "noVNC setup completed."
