# Run Zoltbot on your own server

Zoltbot's daemon runs your agents. Normally it runs on your Mac, inside the desktop app. You can also run it on a Linux server or VM, so agents keep working while your laptop is closed. Your phone and desktop reach it through a relay, the same way the phone reaches your Mac.

What you need:

- A Linux server with systemd, Node.js 24 or later, and git. Or Docker.
- A relay that your server, phone and desktop can all reach over TLS, at a `wss://` address. [Run your own](../services/relay/README.md#self-hosting), or use the one your Zoltbot app already connects to.
- The coding tools your agents use, such as Claude Code or Codex, installed on the server and signed in as the user that runs Zoltbot.

## Install with one command

```bash
curl -fsSL https://zoltbot.ai/install.sh | bash -s -- --relay wss://relay.example.com
```

The script is [`scripts/install.sh`](../scripts/install.sh). It installs Zoltbot for the current user, not root, because agents use the coding tools that user signed in to. It:

1. Clones this repository into `~/.local/share/zoltbot/app`, installs its dependencies and builds the daemon.
2. Makes a key for your saved logins in `~/.config/zoltbot/secret.key`, readable only by you.
3. Writes a systemd user service, `zoltd`, and starts it.
4. Prints a link. Open it on your phone, then confirm the phone on the server.

To see the plan without changing anything, add `--dry-run`. To install a release instead of `main`, add `--version <tag>`.

To keep Zoltbot running after you log out, run this once:

```bash
sudo loginctl enable-linger "$USER"
```

To pair another device later:

```bash
node ~/.local/share/zoltbot/app/scripts/zoltbot-pair.mjs
```

## Run with Docker

```bash
cd deploy/self-host
openssl rand -hex 32 > secret.key && chmod 600 secret.key
sudo chown 1000:1000 secret.key   # the container's user
ZOLTBOT_RELAY_URL=wss://relay.example.com docker compose up -d
docker compose exec zoltd node scripts/zoltbot-pair.mjs
```

The image has no coding tools in it. Build your own image `FROM` it that installs the tools your agents use, then sign in to them with `docker compose exec`. The `/data` volume keeps Zoltbot's data and the tools' sign-ins.

To run your own relay next to it, add `--profile relay`. Build the relay first with `pnpm --filter @zoltbot/relay build`. Then put the relay behind a proxy that serves it over TLS, and use that `wss://` address as `ZOLTBOT_RELAY_URL`.

## Settings

The daemon reads these environment variables:

| Variable | Meaning |
| --- | --- |
| `ZOLTBOT_DATA_DIR` | Zoltbot's data: agents, chats, tasks and memory. |
| `ZOLTBOT_RELAY_URL` | The relay's address. It must start with `wss://`; `ws://localhost` works for testing. |
| `ZOLTBOT_SECRETS_DIR` | Where saved logins are kept, one sealed file each. On Linux it defaults to the data folder's name plus `-secrets`. Setting it on a Mac uses these files instead of the keychain. |
| `ZOLTBOT_SECRET_KEY_FILE` | A 32-byte key, as hex or base64, that seals the saved logins. Without it, the daemon makes a key inside the secrets folder. Keep the key apart from the data, for example as a container secret. |

## How your data is kept

- The daemon listens only on `127.0.0.1`. Devices never connect to the server directly; everything goes through the relay, encrypted end to end, so the relay can't read it.
- Saved logins never go into Zoltbot's database or event log. Each one is a file sealed with AES-256-GCM under your key, readable only by the user that runs Zoltbot.
- The pairing command asks you to check the code the phone shows before it allows the phone. Run it in a terminal on the server.
- Back up the data folder, the secrets folder and the key together. Without the key, the saved logins can't be opened; sign in again.

## Not yet supported

- The desktop app talks to one daemon at a time: the one on the Mac it runs on. Using it with a server's daemon needs the multi-daemon work that's still planned.
- Push notifications from a relay you run yourself need your own build of the iPhone app; see the [relay's README](../services/relay/README.md#self-hosting).
