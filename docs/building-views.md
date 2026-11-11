# Building a Zoltbot view

A view is a folder of static files with a `view.json` manifest. It runs as a sandboxed page in the desktop app. Start with [the chat list example](../packages/view-api/examples/hello-view/), or customize the command map in Settings → Views.

Copy the example folder, keeping its name `hello-view`, then run:

```sh
pnpm view:dev packages/view-api/examples/hello-view
```

Open the loopback URL the command prints. The client starts mock mode after 300 ms without a host connection. `await zolt.ready` returns `mock: true`; chats change state, requests appear, and spending rises using sample data. Valid calls change those samples. Mock grants follow the manifest. Reload the browser after editing files. The development server serves `_host` resources virtually and does not change the view folder.

## Manifest and files

The manifest's `id` must match the folder name: 2–40 lowercase letters, digits or hyphens. Set `manifest: 1`, `api: 1`, a semantic `version`, an HTML `entry`, `slots: ["page"]` and at least the `read` permission. `name` is the sidebar label. Optional fields include `description`, an SVG or PNG `icon`, `shortcuts`, `author` and `license`.

Use [the generated manifest schema](../packages/view-api/schema/manifest.json) for validation. Unknown metadata is ignored. Keep code and assets in the folder: HTML, CSS, JS/MJS, JSON, SVG, Markdown, text, PNG, JPEG, WebP and WOFF2 are allowed. Limits are 500 files, 25 MB per file and 100 MB total. No symlinks, hardlinks, WebAssembly, ambiguous paths, or paths differing only by case. The `_host/` prefix belongs to Zoltbot.

Include the client before your scripts:

```html
<script src="/_host/v1/zolt.js"></script>
<script src="map.js"></script>
```

The leading slash also works for an entry in a subfolder. Bundle libraries and their licenses locally. A view cannot load a CDN, open a network connection, submit a native form, open a popup or access the shell's DOM. For forms, validate fields and handle a button click or Enter yourself. Use `zolt.storage` for saved state; browser storage is unavailable inside the app frame.

## Read data

```js
const facts = await zolt.ready;
const unsubscribe = zolt.subscribe(["chats", "requests"], (topic, value) => {
  if (topic === "chats") renderChats(value);
  if (topic === "requests") renderRequests(value);
});
```

Subscriptions deliver the whole topic value, at most ten times a second. Topics are `chats`, `requests`, `workspaces`, `usage` and `checks`. See [the public types](../packages/view-api/src/topics.ts), [mapping](../packages/view-api/src/model.ts) and [generated schemas](../packages/view-api/schema/). Chat statuses are `needs_you`, `working`, `review`, `later`, `settled` and `idle`. `Workspace.roots` contains labels rather than paths. Chat history and file contents are outside version 1.

Use text nodes or `textContent` for titles, activity and request text. Include a list or equivalent keyboard path for any map or canvas. Pair status colors with words or marks, and provide a pause control for automatic updates.

## Act with the owner's grants

`zolt.granted` contains the current grants. Listen to `zolt.on("grants", callback)` and keep the view useful with `read` alone.

| Permission | Calls |
|---|---|
| `read` | `subscribe`, `storage.get/set`, `app.open` and shortcuts |
| `act` | `chats.send({chatIds, text})`, `chats.interrupt({chatIds})` |
| `approve` | `requests.answer({requestId, version, choiceId?, answers?, feedback?})` |

Send to 1–50 distinct chats with at most 8,000 characters. Results name each chat and say whether it started, queued, interrupted or was skipped. To open a chat, call `zolt.app.open({chatId})`; pages are `needs-you`, `overview` and `settings`.

Show the request's actual `choices`; pass its `version` back unchanged. A widening choice waits for Zoltbot's own confirmation outside the frame. Every answer records the view id in the resolution and audit log. Requests with `answerInChat` need the host's private-input flow: offer Open chat instead.

Question strings select a matching option id or provide Other text; arrays select option ids. Use `{options, other}` when needed. Forms use `{value}` with the existing flat schema in `questions[].schema`. Optional `multi` controls multiple selection. Treat `stale` as a reason to read the request again. Other error codes are `not_granted`, `declined`, `not_found`, `invalid`, `rate_limited` and `unavailable`.

Save one JSON value, no larger than 256 KB:

```js
const saved = await zolt.storage.get();
await zolt.storage.set({ groups: saved?.groups ?? {}, regions: positions });
```

State survives edits, reloads, app updates and removal. Grants live separately in the database. Files, saved state and agents cannot grant a view permissions.

## Theme and keyboard

The client applies resolved semantic `--zb-*` tokens to the root. Style with `var(--zb-bg-page)`, `var(--zb-text)`, `var(--zb-border-control)`, typography, spacing and radius tokens. Use the app's semantic tokens rather than primitives or literal palettes. Ship fonts if needed. Listen to `theme`, `visibility` and `shortcut` with `zolt.on(name, callback)`; each subscription returns an unsubscribe function. Honor reduced motion, 200% text size, 320-pixel reflow, visible keyboard focus and WCAG AA contrast.

The client forwards Cmd+K, Cmd+B, Cmd+I, Cmd+J and Cmd+comma to the app. Double Escape moves focus to the sidebar. Handle other keys when the view has focus. Declare palette shortcuts in the manifest and handle their ids from `zolt.on("shortcut", id => ...)`.

## Install and customize

In the desktop app, use Settings → Views → Import view and select the folder. Import copies it into the data folder, clears imported lineage and starts with no grants. Opening it shows the host's permission dialog. Show in Finder reveals its folder for editing. The daemon reloads user-folder edits after 300 ms and the host replaces the frame when its bundle hash changes.

Customize writes `basedOn` so a later built-in update can offer Keep mine, Use the new version, or Keep both. Keep mine advances the baseline. Use the new version permanently deletes the customized files after confirmation. Keep both renames the custom folder and copies its saved state to the new id; the built-in returns under the original id. Remove also deletes user files immediately after confirmation; saved state remains.

An agent can use `team_view` to list, read and save views from `.zoltbot/staging/<uuid>` under its frozen working folder. Read the current bundle hash, stage only changed or new files, then save with that `baseHash`; the host copies unchanged assets and validates the complete result. Editing a view it did not create in this chat requires a durable owner request showing the changed files. Saving never changes grants. The built-in Building Zoltbot views skill explains this workflow. Enable it through the usual confirmed skill assignment; installing the app does not enable it automatically. The full implementation contract is [views.md](views.md).
