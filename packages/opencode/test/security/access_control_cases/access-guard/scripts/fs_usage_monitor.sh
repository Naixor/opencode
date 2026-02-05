#!/usr/bin/env bash
#
# fs_usage_monitor.sh — Shell wrapper for fs_usage filesystem monitoring
#
# Usage: sudo ./fs_usage_monitor.sh <pid> [output_file]
#
# Monitors filesystem syscalls for a specific PID using fs_usage.
# Writes a PID file for management and handles SIGTERM for clean shutdown.
#

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <pid> [output_file]" >&2
  exit 1
fi

TARGET_PID="$1"
OUTPUT_FILE="${2:-/dev/stdout}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="${SCRIPT_DIR}/.fs_usage_monitor.pid"

# Verify target process exists
if ! kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "Error: Process $TARGET_PID does not exist" >&2
  exit 1
fi

# Check for root/sudo
if [[ $EUID -ne 0 ]]; then
  echo "Error: fs_usage requires root privileges. Run with sudo." >&2
  exit 1
fi

# Write PID file for management
echo $$ > "$PID_FILE"

cleanup() {
  rm -f "$PID_FILE"
  # Kill fs_usage if still running
  if [[ -n "${FS_USAGE_PID:-}" ]] && kill -0 "$FS_USAGE_PID" 2>/dev/null; then
    kill "$FS_USAGE_PID" 2>/dev/null || true
    wait "$FS_USAGE_PID" 2>/dev/null || true
  fi
}

trap cleanup EXIT SIGTERM SIGINT SIGHUP

# Start fs_usage in background, filtering for filesystem events only
fs_usage -f filesystem -w -p "$TARGET_PID" > "$OUTPUT_FILE" 2>/dev/null &
FS_USAGE_PID=$!

# Wait for fs_usage to be killed by SIGTERM or the target process to exit
while kill -0 "$FS_USAGE_PID" 2>/dev/null && kill -0 "$TARGET_PID" 2>/dev/null; do
  sleep 1
done

# If target process exited, give fs_usage a moment to flush then stop it
if ! kill -0 "$TARGET_PID" 2>/dev/null; then
  sleep 0.5
  kill "$FS_USAGE_PID" 2>/dev/null || true
  wait "$FS_USAGE_PID" 2>/dev/null || true
fi
