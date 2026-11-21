#!/usr/bin/env bash
# D10: installs Zoltbot's daemon on a Linux server or VM as a systemd user service, so agents keep
# working while your laptop is closed. Then it prints a link to pair your phone or desktop.
#
#   curl -fsSL https://zoltbot.ai/install.sh | bash -s -- --relay wss://relay.example.com
#
# Options:
#   --relay <url>    The relay your devices reach the daemon through (or ZOLTBOT_RELAY_URL).
#   --version <ref>  The git tag or branch to install (default: main).
#   --dry-run        Print what would happen and the service file, and change nothing.
#
# It runs as you, not root: agents use the coding tools you sign in to on this server.
set -euo pipefail

relay="${ZOLTBOT_RELAY_URL:-}"
version="main"
dry_run=0
repository="https://github.com/zoltlabs/zoltbot.git"

while [ $# -gt 0 ]; do
  case "$1" in
    --relay) relay="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "$1" >&2; exit 1; }

[ -n "$relay" ] || fail "Give the relay address: --relay wss://… (see docs/self-host.md)."
# A plain address only: it goes into the service file, where spaces, % and newlines mean more.
host='[A-Za-z0-9.-]+(:[0-9]{1,5})?'
path_part='(/[A-Za-z0-9._~/-]*)?'
if ! [[ "$relay" =~ ^wss://${host}${path_part}$ || "$relay" =~ ^ws://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?${path_part}$ ]]; then
  fail "The relay address must be a plain wss:// address (or ws://localhost for testing)."
fi
case "$version" in
  "" | *[!A-Za-z0-9._/-]*) fail "The version can only have letters, digits, '.', '_', '/' and '-'." ;;
esac

# systemd reads user services only from the home folder, so everything lives under it.
share="${HOME}/.local/share/zoltbot"
config="${HOME}/.config/zoltbot"
app="${share}/app"
data="${share}/data"
secrets="${share}/secrets"
key="${config}/secret.key"
unit_dir="${HOME}/.config/systemd/user"
unit="${unit_dir}/zoltd.service"

# systemd reads % as a specifier and spaces as separators: escape and quote PATH.
unit_path="${PATH//%/%%}"
unit_path="${unit_path//\"/}"

service_file() {
  cat <<EOF
[Unit]
Description=Zoltbot daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${app}
# Your PATH at install, so agents find the coding tools you installed (nvm, ~/.local/bin, npm).
Environment="PATH=${unit_path}"
ExecStart=/usr/bin/env node ${app}/dist/daemon/zoltd.mjs
Environment=ZOLTBOT_DATA_DIR=${data}
Environment=ZOLTBOT_SECRETS_DIR=${secrets}
Environment=ZOLTBOT_SECRET_KEY_FILE=${key}
Environment=ZOLTBOT_RELAY_URL=${relay}
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=default.target
EOF
}

if [ "$dry_run" = 1 ]; then
  echo "Would install Zoltbot ${version} into ${app}"
  echo "Would keep data in ${data} and saved logins in ${secrets}, sealed with ${key}"
  echo "Would write ${unit}:"
  echo
  service_file
  exit 0
fi

[ "$(uname -s)" = "Linux" ] || fail "This installs on Linux. On a Mac, use the desktop app."
command -v systemctl >/dev/null || fail "This needs systemd."
command -v git >/dev/null || fail "Install git first."
command -v node >/dev/null || fail "Install Node.js 24 or later first."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' ||
  fail "Zoltbot needs Node.js 24 or later; this server has $(node --version)."

umask 077
mkdir -p "$share" "$config" "$data" "$secrets" "$unit_dir"

echo "Getting Zoltbot ${version}…"
if [ -d "${app}/.git" ]; then
  git -C "$app" fetch --depth 1 origin "$version"
  git -C "$app" checkout --quiet FETCH_HEAD
else
  git clone --quiet --depth 1 --branch "$version" "$repository" "$app"
fi

echo "Installing its dependencies…"
(cd "$app" && corepack enable >/dev/null 2>&1 || true)
(cd "$app" && corepack pnpm install --frozen-lockfile --prod=false >/dev/null)
(cd "$app" && node scripts/build-daemon.mjs >/dev/null)

if [ ! -f "$key" ]; then
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' >"$key"
  chmod 600 "$key"
fi

service_file >"$unit"
systemctl --user daemon-reload
systemctl --user enable --now zoltd.service

if ! loginctl show-user "$(id -un)" --property=Linger 2>/dev/null | grep -q yes; then
  echo
  echo "To keep Zoltbot running after you log out, run once: sudo loginctl enable-linger $(id -un)"
fi

echo
echo "Zoltbot is running. Pair a device:"
for _ in $(seq 1 30); do
  [ -f "${data}/daemon.json" ] && break
  sleep 1
done
ZOLTBOT_DATA_DIR="$data" node "${app}/scripts/zoltbot-pair.mjs"
