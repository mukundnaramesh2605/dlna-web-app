#!/bin/sh
# Installs the agent as a per-user LaunchAgent: starts at login, restarts if it
# crashes, and keeps running across sleep/wake (it reconnects on wake).
set -eu
cd "$(dirname "$0")/.."
AGENT_DIR="$(pwd)"
NODE="$(command -v node)"
LABEL="com.dlna.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/dlna-agent.log"

[ -f .env ] || { echo "Create $AGENT_DIR/.env first (cp .env.example .env)"; exit 1; }
[ -d node_modules ] || npm ci --omit=dev

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file=.env</string>
    <string>src/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$AGENT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $PLIST"
echo "Logs: tail -f $LOG"
