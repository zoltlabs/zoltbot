# Packaging and release review

On macOS with Node 24, build a local unsigned Apple silicon package:

```sh
pnpm package:desktop --unsigned --arm64
```

The output is `dist/release/Zoltbot-<version>-arm64.dmg`. Omitting `--arm64`
builds both Mac architectures. `--unsigned` selects ad hoc signing and disables
notarization. Packaging never publishes automatically and does not launch the app.
Keep local builds separate from official release artifacts.

The app includes compiled desktop and daemon code, UI assets, its Node runtime,
SQLite bindings, native helpers, migrations, artifact-kit resources and required
third-party notices. Review package contents and rerun isolated native acceptance
before distributing a new version. Signing does not replace that review.

Official signing and notarization belong in protected release environments.
Credential names used by packaging include `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Keep values and private key files
outside source control. Signed builds also need `ZOLTBOT_HOSTED_ORIGIN`: official builds use
`https://zoltbot.ai`, and forks use their own origin or `none`. `ZOLTBOT_RELAY_URL` optionally
names a default phone relay (official builds: `wss://relay.zoltbot.ai`). Publication is a separate, explicitly approved action.

To build or submit the iPhone app with EAS, use your own Expo owner, bundle identifiers
and App Groups, and set `APPLE_TEAM_ID`, `EXPO_PROJECT_ID` and `EXPO_ASC_APP_ID`.
No account identifiers are checked in. Review `apps/mobile/app.json`,
`apps/mobile/eas.json` and its sharing plugin before using EAS.
