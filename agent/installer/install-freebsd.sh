#!/bin/sh
# Obliview Agent Installer for FreeBSD
# Usage: fetch -qo - "https://your-server/api/agent/installer/freebsd?key=<apikey>" | sh
# Or:    sh install-freebsd.sh --url https://your-server --key <apikey>

set -e

SERVER_URL="__SERVER_URL__"
API_KEY="__API_KEY__"
INSTALL_DIR="/usr/local/obliview-agent"
CONFIG_DIR="/usr/local/etc/obliview-agent"
SERVICE_NAME="obliview_agent"
BINARY_NAME="obliview-agent"
RC_SCRIPT="/usr/local/etc/rc.d/${SERVICE_NAME}"

# Parse args (override injected values)
while [ $# -gt 0 ]; do
  case $1 in
    --url=*) SERVER_URL="${1#*=}" ;;
    --key=*) API_KEY="${1#*=}" ;;
    --url)   SERVER_URL="$2"; shift ;;
    --key)   API_KEY="$2"; shift ;;
  esac
  shift
done

if [ -z "$SERVER_URL" ] || [ "$SERVER_URL" = "__SERVER_URL__" ]; then
  echo "Error: --url is required"; exit 1
fi
if [ -z "$API_KEY" ] || [ "$API_KEY" = "__API_KEY__" ]; then
  echo "Error: --key is required"; exit 1
fi

echo "=============================="
echo " Obliview Agent Installer"
echo "=============================="
echo "Server URL : $SERVER_URL"
echo "Install dir: $INSTALL_DIR"
echo ""

# ── 1. Detect architecture ────────────────────────────────────────────────────

ARCH=$(uname -m)
case "$ARCH" in
  amd64|x86_64) BINARY_SUFFIX="freebsd-amd64" ;;
  arm64|aarch64) BINARY_SUFFIX="freebsd-arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH (supported: amd64, arm64)"
    exit 1
    ;;
esac

echo "[1/4] Architecture: $ARCH"

# ── 2. Download binary ────────────────────────────────────────────────────────

echo "[2/4] Downloading agent binary..."
mkdir -p "$INSTALL_DIR"
fetch -qo "$INSTALL_DIR/$BINARY_NAME" \
  "${SERVER_URL}/api/agent/download/obliview-agent-${BINARY_SUFFIX}"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

# ── 3. Write config ───────────────────────────────────────────────────────────

echo "[3/4] Writing configuration..."
mkdir -p "$CONFIG_DIR"

DEVICE_UUID=$(uuidgen 2>/dev/null || \
              cat /dev/urandom | tr -dc 'a-f0-9' | head -c 32 | \
              sed 's/\(.\{8\}\)\(.\{4\}\)\(.\{4\}\)\(.\{4\}\)\(.\{12\}\)/\1-\2-\3-\4-\5/')

cat > "$CONFIG_DIR/config.json" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "apiKey": "$API_KEY",
  "deviceUuid": "$DEVICE_UUID",
  "checkIntervalSeconds": 60,
  "agentVersion": "1.0.0"
}
EOF

# ── 4. Install rc.d service ───────────────────────────────────────────────────

echo "[4/4] Installing rc.d service..."

cat > "$RC_SCRIPT" <<RCEOF
#!/bin/sh
# PROVIDE: ${SERVICE_NAME}
# REQUIRE: NETWORKING DAEMON
# KEYWORD: shutdown

. /etc/rc.subr

name="${SERVICE_NAME}"
rcvar="${SERVICE_NAME}_enable"
command="$INSTALL_DIR/$BINARY_NAME"
pidfile="/var/run/\${name}.pid"
command_args="&"

start_cmd="\${name}_start"
stop_cmd="\${name}_stop"

${SERVICE_NAME}_start() {
  /usr/sbin/daemon -p \${pidfile} -t "Obliview Agent" \${command}
}

${SERVICE_NAME}_stop() {
  if [ -f \${pidfile} ]; then
    kill \$(cat \${pidfile}) 2>/dev/null || true
    rm -f \${pidfile}
  fi
}

load_rc_config \${name}
: \${${SERVICE_NAME}_enable:=YES}
run_rc_command "\$1"
RCEOF
chmod +x "$RC_SCRIPT"

sysrc "${SERVICE_NAME}_enable=YES" >/dev/null
service "$SERVICE_NAME" restart || service "$SERVICE_NAME" start

echo ""
service "$SERVICE_NAME" status || true
echo ""
echo "=============================="
echo " Installation complete!"
echo " The agent will appear in"
echo " the Obliview admin panel"
echo " once approved."
echo "=============================="
