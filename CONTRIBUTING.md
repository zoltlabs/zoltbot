# Contributing

Thanks for helping. Bug reports, fixes, and new provider adapters are all welcome. For a large change, open an issue first so we can agree on the approach.

## Setup and checks

Follow the [quick start](README.md#quick-start), then run these before opening a pull request:

```sh
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test:e2e` and `pnpm check` launch real Electron windows. Run them on an isolated display, such as a separate macOS user or a virtual machine, rather than on your own desktop. There is no hosted CI, so run the checks above before you open a pull request.

## Guidelines

- Read the [design invariants](docs/architecture.md). Pull requests that weaken one won't be merged, even if that would make a feature or test easier.
- Keep provider-specific code inside `packages/adapters/*`.
- Keep each module under about 800 lines, and keep each change focused.
- Add or update tests with every behavior change. Tests use synthetic providers and fixtures, never real credentials, recordings, or personal data.
- Don't commit secrets. To build the iPhone app under your own account, set `APPLE_TEAM_ID`, `EXPO_PROJECT_ID` and `EXPO_ASC_APP_ID`, and use your own bundle identifiers.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
