#!/bin/sh
# B8: the agent's own desktop. Starts a virtual screen, a window manager and a VNC server on
# ZOLTBOT_DESKTOP_PORT (default 5900), for the daemon to reach through the target's private port.
# ZOLTBOT_VNC_PASSWORD is required: letters and digits, and VNC uses only its first 8. It reaches
# x11vnc through a file x11vnc removes once read, never through argv or the children's env.
# The display has no X auth: everything in the sandbox is the agent's.
set -eu
port="${ZOLTBOT_DESKTOP_PORT:-5900}"
display="${ZOLTBOT_DISPLAY:-:1}"
geometry="${ZOLTBOT_DESKTOP_SIZE:-1280x800}"
socket="/tmp/.X11-unix/X${display#:}"
case "${ZOLTBOT_VNC_PASSWORD:-}" in
  "" | *[!A-Za-z0-9]*)
    echo "zolt-desktop: set ZOLTBOT_VNC_PASSWORD to letters and digits" >&2
    exit 2
    ;;
esac
if [ -e "$socket" ]; then
  echo "zolt-desktop: display $display is already running" >&2
  exit 3
fi
umask 077
secret="$(mktemp)"
trap 'rm -f "$secret"' EXIT INT TERM
printf '%s\n' "$ZOLTBOT_VNC_PASSWORD" > "$secret"
unset ZOLTBOT_VNC_PASSWORD
Xvfb "$display" -screen 0 "${geometry}x24" -nolisten tcp &
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "$socket" ] && break
  sleep 0.5
done
if [ ! -e "$socket" ]; then
  echo "zolt-desktop: the virtual screen didn't start" >&2
  exit 1
fi
DISPLAY="$display" openbox >/dev/null 2>&1 &
# x11vnc removes the file itself (rm:); the trap covers a failed exec.
exec x11vnc -display "$display" -rfbport "$port" -passwdfile "rm:$secret" -forever -shared -noxdamage -quiet
