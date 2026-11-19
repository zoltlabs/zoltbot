# Local development

Use Node 24 and pnpm 11. Install with `pnpm install --frozen-lockfile`.
The repository cache and synthetic test data live under `.cache`.

Noninteractive checks:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build:ui
pnpm build:desktop
pnpm build:shell
```

`pnpm dev:desktop` builds the daemon and opens the desktop app (`apps/shell`) with hot reload;
do this only when you intend to open a window. `pnpm --filter @zoltbot/shell test:feel` runs the
app's renderer headless against a real daemon and records how fast switching, sending and
answering are. `pnpm dev:legacy-desktop` opens the previous desktop app (`apps/desktop` with
`packages/ui`), which stays until the new app covers everything it does. `pnpm dev:ui` serves
that previous renderer in a browser. Automated browser checks
stay headless. There is no hosted CI. Run Electron acceptance on an isolated display, or obtain
explicit authorization for that local run. `pnpm check` includes Electron acceptance.

`pnpm test:results` checks Results, artifact comparison, completion cards and waiting
states in a headless browser, including both themes, narrow layouts and keyboard access.
`pnpm test:compare` and `pnpm test:shipping` cover the existing comparison and shipping flows.

Developer builds leave hosted accounts and broker integrations disabled unless
configured. See [hosted services](hosted-services.md). Explicit third-party agent
and API traffic follows the tools and credentials you select.

The desktop app is in `apps/shell` (Electron main, preload and a SolidJS renderer based on
OpenBot v0.1.11), the previous app in `apps/desktop` and `packages/ui`, orchestration in
`packages/daemon`, and shared wire types in `packages/protocol`.
The component gallery is available at the local UI server's `/#components` route.
Packaging is described in [releasing](releasing.md).
