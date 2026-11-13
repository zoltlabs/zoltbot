# Cloud settings

`CloudSettings` renders account metadata and calls a native settings bridge. It
holds key drafts only until a successful write or an account change. It never
reads saved provider credentials or receives an account bearer or Cell token.
Every mutation carries the session that rendered its controls. The native bridge
must refuse a stale session before performing side effects.

The component is not yet mounted in the packaged Settings page. Main-process
account ownership, connection management and daemon startup remain unfinished;
this component alone cannot enable Cloud or start a runner. The existing packaged
sign-in flow remains selected until its migration behavior is approved.

Implementation choices:

- Keep save buttons focusable while pending and refuse duplicate submissions.
  Retain a failed draft so the person can retry; clear it after success.
- Clear the full screen immediately on an account-change notification and ignore
  any response from the prior generation. Key forms also remount per session.
- Offline and ineligible accounts expose disabled controls. An unconfigured
  build exposes no account actions.
- Use the shared controls, typography and theme tokens. Field boundaries use the
  control border token to retain at least 3:1 contrast against both adjacent surfaces.

`playwright.cloud-ui.config.ts` runs an isolated headless browser fixture with
memory-only native ports. It checks validation, failure recovery, stale account
results, keyboard focus, available/disabled states, Axe, measured contrast and
320 CSS-pixel reflow at 200% text resize in both themes. No Electron process,
account service or owner keychain is involved. Screen-reader announcements and
packaged navigation still require separate verification.
