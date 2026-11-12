# Views phase 4 verification

The design pass on the built-in command map is on `main` in four commits. Nothing was pushed. The View API, the sandbox, the security headers, the file rules, the bridge limits and the permissions are unchanged; `apps/desktop/src/view-protocol.ts` and `packages/daemon/src/views/` were read and not edited.

| Commit | Subject |
| --- | --- |
| `515d5f8` | Add six-chat and 200-chat sample cases to the view mock |
| `9af4e61` | Rebuild the command map as a miniature diorama on three.js 0.187 |
| `23deb2e` | Polish the command map after visual review |
| this commit | Record the phase 4 design pass and its verification |

`515d5f8` also removed the old `scene.js` and the three.js 0.128 build, which were staged by mistake. The map did not load at that commit; `9af4e61` completes the change.

## What was built

[The phase 4 section of the specification](../views.md#phase-4-design-pass-on-the-command-map) describes the result. In short: islands, workshops with signs, and provider-styled robots; a distinct shape and motion for each state; day and night palettes; shadows, ambient occlusion, bloom, fog and tilt-shift; a damped perspective camera with simple markers when zoomed out; one HUD with edge alerts that show waiting time; three synthesized sounds, off by default; three graphics levels with automatic selection; and a folder split into `skin.js`, `world/` builders and logic files, with a README.

## Numbers

Measured with `renderer.info` (reset once per frame, so every pass counts) in `tests/views/command-map.spec.ts`, with the 200-chat sample case at zoom 1:

| Graphics level | Draw calls | Triangles | Passes |
| --- | --- | --- | --- |
| High | 114 | 348,736 | ambient occlusion, bloom, tilt-shift, shadows |
| Medium | 62 | 174,346 | bloom, shadows |
| Low | 35 | 108,220 | none |

The budget is 300 draw calls and 500,000 triangles. Zoomed out to the whole map (pawns instead of robots) the high level used 90 to 92 draw calls and about 258,000 triangles in the final screenshots.

The view folder is 1,020 KB on disk: the three.js bundle is 810 KB and the view's own code, styles and documents make up the rest. The limit for this phase is 5 MB. No own-code file is longer than 393 lines.

Headless Chromium renders WebGL in software, so no frame rate was measured.

## Script loading

A probe page loaded an ES module with an import map inside a `sandbox="allow-scripts"` frame, under the view's Content Security Policy with `Access-Control-Allow-Origin: null`, in headless Chromium. Both the module and a classic script ran. The view still uses classic scripts for two reasons: the existing tests in `packages/view-api/src/command-map.test.ts` load `layout.js` and `panels.js` as classic scripts, and Electron's `zoltbot-view:` scheme could not be checked without launching the app. three.js 0.187.0 and its add-ons are bundled into one classic script by `scripts/build-command-map-vendor.mjs`, which downloads the pinned npm package, checks its integrity hash and bundles it with the repository's esbuild.

## Checks

All commands ran from the repository root. `pnpm test` and the two builds ran before the last small change (a fallback to the low graphics level if the effects fail to render, and these documents); typecheck, lint, the view unit tests and the headless workflows ran again after it.

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed. The one warning in the view folder (`!important` on `[hidden]`) was there before this phase. |
| `pnpm test` | 388 files passed, 2 skipped; 2,507 tests passed, 24 skipped (the Docker and live E2B suites), in 398.84 seconds |
| `pnpm build:ui` | Passed, with the existing bundle-size advisory |
| `pnpm build:desktop` | Passed, with the existing artifact-kit `import.meta` warning |
| `pnpm exec playwright test --config tests/views/playwright.config.ts` | 14 workflows passed in 1.8 minutes: the 6 from phases 1–3 and 8 new ones |

Other sessions had uncommitted work in this checkout while these ran, so the full-suite counts include their changes.

New tests:

| Requirement | Test |
| --- | --- |
| Performance budget | `command-map.spec.ts`: 200 chats within 300 draw calls and 500,000 triangles at high, medium and low, and when zoomed out to the whole map |
| Graphics levels | The same test checks which passes and shadows each level runs, that the choice is saved through `storage`, and that it is applied after a reload. `command-map.test.ts` checks that Auto starts low on a software renderer, steps down on slow consecutive frames, ignores pauses between idle frames, and never overrides the owner's choice. |
| Stops when hidden, idles when still | `command-map.spec.ts`: no frame is drawn while hidden or while nothing moves |
| Reduced motion | `command-map.spec.ts`: no opening animation, the camera reaches its target in one frame, nothing is animated, and every state has its words in the list and on the unit's accessible name |
| Works with `read` alone | `command-map.spec.ts`: the map, list, alert navigation, request text with Open chat, control groups and saved settings work; orders are absent; `chats.send` fails with `not_granted` |
| Edge alerts | `command-map.spec.ts`: at most six, each named with its waiting time; clicking one selects and shows the chat |
| Contrast | `command-map.spec.ts`: every text, icon and control-border pair in the HUD and side panel, measured against the color actually behind it. Light: 26 pairs, lowest text 5.44:1, lowest icon or border 4.83:1. Dark: 28 pairs, lowest 5.08:1. Disabled controls are exempt. |
| Pointer and keys | `command-map.spec.ts`: hover, Shift+click, click to open, box select, group keys, Escape, zoom, fit and Space |
| Layout, states, folder rules | `command-map.test.ts`: 200 chats placed without overlap inside separate regions; status-to-state mapping; waiting times; palettes in step; folder under 5 MB, own files under 800 lines, no network address in own code |

## Visual review

Screenshots were taken headlessly with sample data in both themes at 1440×900 and 900×700: first load, default zoom, zoomed in on a working unit, the whole map, an off-screen alert, a selected group with the orders panel, the request panel, reduced motion, and the 200-chat case at default zoom, whole map and with a selection. Each scene runs at the low level and the final frames are drawn at high, because software rendering takes seconds per high-level frame. The final set is in `output/command-map/final/` (44 files, not committed).

What each round found and changed:

1. First renders. Robots were too small to read and the "needs you" mark used the theme's text-contrast orange, which is dull on grass. Robots grew by 40%, the camera moved closer, and marks got their own brighter palette. The high level drew 511,000 triangles for 200 chats; simpler boxes and fewer shadow casters brought that under budget. The opening view now fits small maps.
2. Night. The first night palette was too dark to see buildings, the sea was a saturated blue, and bloom from many beacons washed the whole map red when zoomed out. Moonlight and sky light went up, the sea became a neutral dark, ground rings stopped glowing, and bloom now eases off with zoom. Name tags overlapped; they now stack, and far out they show only the waiting time.
3. Selection and small windows. A selection near the top blurred the middle of the map, so the focus row is kept near the center and the blur is lighter. At 900×700 the group chips covered an edge alert, so alerts now sit above every control. Signs were dim at night under ambient occlusion and are now one lit plate each. At the low level beacons looked yellow because bright values clipped; lights are now drawn at their plain color without bloom.

## Not reached

- The opening animation, sparks, steam, confetti, the hop and the camera easing were reviewed only as code and single frames. Stills cannot show whether they feel right.
- Water is a flat calm color with a shallow band and a foam line. It has no ripples or reflections.
- The tilt-shift blur works by screen row, not by true depth, so a tall object that crosses the focus row is sharp at one end and soft at the other.
- A working robot hammers in its own slot in front of its workshop, with sparks, lit windows and chimney steam. There is no workbench or interior.
- Ambient occlusion is gentle. Stronger settings darkened the small robots too much in software rendering; it needs tuning on a real GPU.
- Sign text is legible from about zoom 2. At zoom 1 a sign is about 55 pixels wide.

## Limits

No hard limit needed lifting. All geometry, textures and sound are built in code, so model and audio files were not needed.

## Skills

`clean-copy` and `clear-writing` were read and applied to the HUD strings, the README and these documents. The main guides of `better-accessibility`, `better-ui`, `better-colors` and `better-layout` were read and applied: native controls, visible focus, a second cue for every state, measured contrast, hover styles only on hover-capable pointers, contained panel scrolling, named transition properties, and no token used outside its role. Their linked reference files were not read. No skill was missing.

## Checks a person must do in the running app

No Electron app or visible window was launched. These remain unverified:

1. The map loads through `zoltbot-view:` in the real app with the new bundle and the `world/` subfolder.
2. Smoothness on real hardware: camera easing, the opening animation, and whether Auto stays at High on a normal Mac and steps down on a slow one.
3. Power use: the map should stop drawing when another page is shown and idle when no chat is working.
4. Sound: turn it on and hear the three cues when a chat needs you, finishes and fails. Check the volume against other apps.
5. Real chats: each provider's robot color and head detail, long titles and branch names on signs, a session problem, and many chats in one worktree.
6. Night and day against the app's dark and light themes, including a theme switch while the map is open.
7. VoiceOver through the chat list, the request panel and the HUD, and the map at 200% text size.
8. Reduced motion set in macOS, to confirm the host passes it to the view.
