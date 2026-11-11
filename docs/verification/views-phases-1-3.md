# Views phases 1–3 verification

Implemented on `main`, with one commit per numbered step and follow-up fixes. No push or pull request. Phase 4, later work and slots other than `page` were not started. The owner's follow-up replaced removal/restore with immediate confirmed deletion; saved state survives.

## Phase 1

Built the typed View API and schemas, snapshot mappings, checked bundle loader and asset routes, isolated desktop protocol, bounded frame bridge, offline client, shell integration and read-only command map. The map vendors unmodified three.js 0.128.0 with its MIT license.

| Commit | Subject |
| --- | --- |
| `9e5a458` | Specify immediate confirmed deletion for removed views |
| `a78257e` | Add versioned view schemas and snapshot mappings |
| `d7db39d` | Fix prototype lint errors and split its stylesheet |
| `e1af3e9` | Reconcile pending company handoffs before accepting clients |
| `7d50008` | Load view bundles with validated files and authenticated assets |
| `b2f1417` | Serve isolated view bundles through the desktop protocol |
| `4af90bc` | Host read-only views in the shell with a bounded message bridge |
| `1c769ff` | Provide the offline view client and shortcut forwarding |
| `4c4c1a9` | Build the offline read-only command map and verify it headlessly |

Ran focused Vitest suites for `packages/view-api`, `packages/protocol`, `packages/artifact-validation`, `packages/store`, `packages/daemon`, `apps/desktop` and `packages/ui` as their steps landed. Passing checkpoints included 860 tests for loader/package integration, 239 desktop/UI tests, 218 UI tests, 62 client tests and 123 final regression tests. Manifest tests accept/reject each rule; loader tests cover user precedence, broken-folder fallback, symlinks, file limits and hashes. Mapping fixtures cover all six chat statuses. Protocol tests cover headers, hashes, traversal and cross-view/network denial. Bridge tests cover handshake, size and rate limits.

At phase end, all five required commands passed:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`: 367 files passed, 2 skipped; 2,411 tests passed, 24 skipped.
- `pnpm build:ui`
- `pnpm build:desktop`

`pnpm exec playwright test --config tests/views/playwright.config.ts` passed the then-current single headless workflow.

Done-when evidence:

| Requirement | Verification |
| --- | --- |
| Real chats in the correct states | Pure mappings cover every status; the built UI renders those snapshots headlessly. Live native chats remain unverified. |
| Off-screen chat raises an edge alert | Headless map workflow selects the off-screen alert and opens its chat. |
| No network requests from the frame | Protocol/request-filter tests and headless network attempts are denied. Electron's actual custom-scheme session remains unverified. |
| Revoking read unloads the view | Headless workflow revokes read and asserts the frame disappears. |

A clean worktree at `dedc2a0` reproduced seven existing Biome errors in the prototype. Commit `d7db39d` fixes them and extracts CSS to keep the module small. The new asynchronous registry startup also exposed a company-handoff timing dependency: the clean baseline's recovery test passed, so this was treated as an integration regression, not a pre-existing failure. Commit `e1af3e9` reconciles pending handoffs before clients are accepted; subsequent package and full checks passed.

## Phase 2

Built database-only grants/review records, settings and host grant dialogs, authorized action calls, host confirmation for widening answers, resolution/audit attribution, persistent view state, shortcuts and Escape exit. The map gained requests, forms, editable orders, groups and saved controls.

| Commit | Subject |
| --- | --- |
| `1960024` | Persist owner grants and expose view permissions in settings |
| `c0ddda3` | Authorize view actions and confirm widening answers in the host |
| `d0fdc91` | Persist view state and route declared shortcuts through the host |
| `4cf845a` | Add map requests, editable orders and persistent controls |
| `4ea1068` | Preserve Other answers in the map question panel |
| `88d7328` | Measure map form contrast in both themes |

Step checks used `pnpm exec vitest run` with the touched protocol/store/daemon/UI/view-API paths. Passing checkpoints: 625 tests for grants/settings; 1,465 for actions and attribution; 681 plus 497 daemon tests for state/shortcuts; 100 focused map tests. Headless workflows ran after the UI steps. Contrast assertions measure form controls in both themes.

At phase end, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:ui` and `pnpm build:desktop` all passed. Full tests: 371 files passed, 2 skipped; 2,447 tests passed, 24 skipped. The final headless workflow passed.

Done-when evidence:

| Requirement | Verification |
| --- | --- |
| Each call without its grant returns not_granted | Per-call daemon tests cover send, interrupt, answer, open and storage. Bridge tests enforce the same boundary. |
| Widening cannot finish without the host dialog | Unit tests reject unconfirmed execution. Headless tests hold the request, cancel without sending, then confirm outside the iframe before sending. |
| Answers identify the view in the audit log | Tests inspect `via` in resolutions and view attribution in audit entries across approval, question, form and plan paths. |

Mac-only catalog/dispatch tests reject phone grant changes; the bridge has no grant mutation method. Real Electron dialog presentation remains unverified.

## Phase 3

Built Customize/lineage and all update choices, one debounced recursive user-folder watcher, import and immediate deletion, standalone mock mode and preview server, the public guide/example, and the built-in authoring skill plus consented `team_view` saves.

| Commit | Subject |
| --- | --- |
| `7f85660` | Customize builtin views and resolve updates without merging work |
| `677fdb8` | Reload edited user views with one debounced folder watcher |
| `2e9bf80` | Import views without grants and remove user folders immediately |
| `23f089f` | Preview views with standalone mock data and an authoring guide |
| `060bce2` | Add the view authoring skill and consented staged saves |

Step verification commands and results:

| Step | Commands and evidence |
| --- | --- |
| Customize/update | `pnpm exec vitest run` over touched daemon/UI/protocol packages: 1,089 tests passed. Headless: two workflows passed. Tests inspect `basedOn`, folders, rename identity, collisions, grants and state for keep/replace/copy. |
| Watch/reload | `pnpm exec vitest run packages/daemon/src`: 504 tests passed. Real filesystem watcher test covers debounce and cleanup. Three headless workflows passed, including new frame hash/content after a watched edit. |
| Import/remove | Touched daemon/UI/desktop/protocol suites: 1,124 tests passed. Three headless workflows passed. Tests assert import strips lineage and starts without grants, deletion follows confirmation/audit, override reveals built-in, standalone disappears, saved state survives and reimport clears grants. |
| Mock/guide | Focused View API/dev-server suites: 65 tests passed. Five headless workflows passed. `pnpm view:dev packages/view-api/examples/hello-view` loopback smoke served the view and stopped on SIGTERM. Mock tests run library and calls without a host; the example stays read-only and no host files are written into the bundle. |
| Skill/tool | `pnpm exec vitest run packages/daemon/src packages/skills/src packages/ui/src`: 765 tests passed. Final focused view/skill/MCP/source/privacy suites: 81 passed. Separate MCP contract tests: two passed. Skill validator passed. Tests cover bounded source reads, frozen proposals, host consent, stale-base preservation, approval after turn completion, private text, staging scope/symlinks, no grant changes, and preserving edited/removed built-in skills. |

Final phase checks all passed: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:ui`, `pnpm build:desktop`. Full suite: 379 files passed, 2 skipped; 2,474 tests passed, 24 skipped (389.06 seconds). Final headless command `pnpm exec playwright test --config tests/views/playwright.config.ts`: six workflows passed.

Done-when evidence:

| Requirement | Verification |
| --- | --- |
| Press Customize | Headless built UI creates a user override; daemon tests inspect copied files and exact `basedOn`. |
| Ask an agent to change colors | Tool integration tests stage CSS, freeze proposed bytes, obtain durable owner consent, apply the edit and preserve grants. A live provider conversation remains unverified. |
| See the change without restarting | Headless tests run the real registry/protocol handler with a fake daemon transport and assert a new frame/content after file and approved tool edits. |
| Install a newer built-in and retain customization | Tests change the shipped fixture version/hash, reload, verify the customized folder stays and expose `builtinUpdate`. Installing an actual packaged upgrade remains unverified. |
| Working prompt for each update choice | Headless UI exercises keep, replace (with host confirmation), and copy. Filesystem tests inspect folder/state outcomes and collision handling for each. |

The latest user instruction supersedes the original Restore test requirement: there is deliberately no Restore action or retained removed folder.

## Spec adaptations

Each adaptation was recorded in `docs/views.md` alongside its implementation:

- Immediate confirmed, audited deletion replaces trash/retention/restore, including the replace update choice, as requested by the owner.
- Shipped assets may be root-owned; user assets keep current-user ownership checks. Canonicalizing the built-in parent supports installation symlinks without allowing symlinks inside bundles.
- Unsupported manifests report the required View API version. Existing code has no mapping to an unknown future app release.
- Renderer records add reviewed permissions, removal tombstones, shortcut declarations and change time because the projector retains rows and the host needs those fields.
- Added the Mac-only `view.call` wrapper and explicit replacement confirmation. The frame never supplies host confirmation.
- Keep both resolves name/state collisions, preserves original state, copies state to the renamed id, starts that id without grants and retains its built-in lineage.
- UI CSP permits checked view icons. Frame isolation remains unchanged.
- Request context omits filesystem paths to follow the spec's final privacy decision. Snapshot activity uses projected tool/plan items, not raw events.
- Question/form shapes follow existing interaction validation, including multiple choices with Other, structured form values and private questions answered in chat. Native form submission stays blocked; buttons/Enter invoke validated bridge calls.
- Budgets follow the existing daily USD budget setting; no monthly budget was invented.
- `view_reviews` remembers declined permissions, preventing repeated prompts. Import clears grants and review history, including reused removed ids, and strips imported lineage.
- Internal state RPCs return object results to match the dispatcher; the public library returns the specified bare values. Added event listeners and ping/pong liveness messages.
- `app.open` arrived with phase 1 because clicking a read-only map unit must open its chat.
- Preview serves client/mock/tokens virtually under reserved `_host/`; copying them into the folder would invalidate it.
- The first built-in skill uses the existing library and confirmed assignment flow; it is not automatically enabled. Owner edits/removal survive registration.
- `team_view` uses bounded reads and changed/new-file overlays with `baseHash`, carrying unchanged libraries on the host. It cannot delete existing files. Protected settings retain origin/proposal metadata and the existing interaction engine handles durable consent; no existing table was changed.

## Remaining manual checks

During the original implementation run, no Electron app, visible browser window, native folder picker or Finder was launched, and no desktop keyboard or mouse input was sent. The follow-up run below received authorization for Electron but could not complete native interaction. Do not treat the following as passed:

1. Actual Electron `zoltbot-view:` loading, CSP/request-filter behavior, renderer process separation and visual rendering.
2. Sidebar/palette placement, keyboard exit and grant/widening dialogs in the running native app. The built UI versions were exercised headlessly.
3. Live native chats and requests updating the map during real agent work; ask a real agent to edit colors using the enabled skill and approve its proposed files.
4. Native import folder picker and Finder action. Their guarded IPC/path helpers and headless stubs were tested.
5. Install a newer packaged app over an existing customized map and exercise all three update prompts; check bundled skill/library resources in that installed app.
6. Manual screen-reader/VoiceOver use and visual inspection at desktop display sizes. Automated keyboard, semantic-token and contrast checks do not replace this inspection.

`verifyMainFrame` was compared with the starting commit and is byte-for-byte unchanged. Added first-party source was checked for personal home-folder paths. `gitleaks git . --log-opts='dedc2a0..HEAD' --redact` scanned 20 implementation commits and found no leaks.

The 24 skipped tests are the existing Docker and live E2B suites. Nonfatal diagnostics remain: prototype CSS/style warnings, the UI bundle-size advisory, and the existing artifact-kit CommonJS `import.meta` build warning. No checks were weakened to suppress them.


## Follow-up test run

The owner requested another test run after the implementation report and explicitly authorized a local Electron test using synthetic data and input confined to its test window.

All required checks passed again on the implementation source at `ba34a31`:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`: 379 files passed, 2 skipped; 2,474 tests passed, 24 skipped, in 392.26 seconds.
- `pnpm build:ui`
- `pnpm build:desktop`
- `pnpm exec playwright test --config tests/views/playwright.config.ts`: six workflows passed in 16.9 seconds against the fresh UI build.

The same existing lint/build warnings and Docker/live E2B skips remain. No production source changes were needed.

Cua Driver launched a separate Electron instance in the background with a temporary app data directory. A screenshot showed the native shell on its setup page. The first synthetic daemon setup failed because it combined conflicting host options; after correcting that test harness and its initial session-state setup, the daemon started successfully. An authenticated loopback snapshot verified all six mapped chat states and an empty grant list for the command map. This fixture has no runtime host and cannot launch real provider processes.

Cua's subsequent targeted window read reported `screen_locked`, an empty accessibility tree, and refused accessibility, pointer and keyboard routes. No native input was attempted around that refusal. The native map, grant/widening dialogs, scheme isolation and app actions therefore remain unverified. The owner was asked to unlock the Mac. The test Electron instance was closed, the synthetic daemon stopped cleanly, and the Cua session ended. Temporary fixture data remains outside tracked source for a later continuation.
