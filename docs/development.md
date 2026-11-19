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
```

`pnpm dev:ui` starts the local renderer server. `pnpm dev:desktop` launches the
native app; do this only when you intend to open a window. Automated browser checks
stay headless. There is no hosted CI. Run Electron acceptance on an isolated display, or obtain
explicit authorization for that local run. `pnpm check` includes Electron acceptance.

`pnpm test:results` checks Results, artifact comparison, completion cards and waiting
states in a headless browser, including both themes, narrow layouts and keyboard access.
`pnpm test:compare` and `pnpm test:shipping` build the `apps/shell` renderer and run the
comparison and shipping flows against it in headless Chromium. Flows the shell has no screen for
yet are listed in `apps/shell/e2e/NOT-PORTED.md`; `pnpm test:compare:ui` and
`pnpm test:shipping:ui` still run them against `packages/ui`.

Developer builds leave hosted accounts and broker integrations disabled unless
configured. See [hosted services](hosted-services.md). Explicit third-party agent
and API traffic follows the tools and credentials you select.

The desktop shell is in `apps/desktop`, renderer in `packages/ui`, orchestration in
`packages/daemon`, and shared wire types in `packages/protocol`.
The component gallery is available at the local UI server's `/#components` route.
Packaging is described in [releasing](releasing.md).
