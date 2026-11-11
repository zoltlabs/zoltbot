# Views: custom interfaces for Zoltbot

Status: implementation in progress. Phase 1 passed its automated checks and headless verification. Phase 2 passed its automated checks and headless verification. Phase 3 is underway. This document is the specification to implement from.

A view is a small web page that Zoltbot shows inside the desktop app and feeds with live data about your chats. People can change a built-in view, write their own, or ask an agent to write one. Their changes are files on disk outside the app, so installing a new version of Zoltbot keeps them.

The first built-in view is the command map: a strategy-game map where each chat is a unit, each workspace is a region, and a chat that needs you raises an alert you can jump to.

## Goals

* A person can change how Zoltbot looks and works without forking the app.
* Customizations survive app updates and never block one.
* A view written for API version 1 keeps working while Zoltbot's internal protocol changes.
* A view cannot read the owner token, reach the network, or act beyond what the owner granted it.
* Zoltbot ships at least one built-in view, built on the same API as everyone else's.

## Not in this plan

* Clients outside the desktop app (a standalone game, a browser tab, a script). See "Later work".
* Views on the phone.
* A gallery or store for sharing views.
* Changing the sidebar, the status bar or other parts of the shell. The manifest reserves room for it; see "Slots".

## Decisions already made

| Question | Decision |
|---|---|
| Where do views run first? | Inside the desktop app only. |
| Can a view answer approvals and questions? | Yes, when the owner grants that view the `approve` permission. Off by default. |
| Can a view reach the network? | No. Every file a view needs is in its folder. |

## Terms

| Term | Meaning |
|---|---|
| View | A folder of static files with a `view.json` manifest. |
| Built-in view | A view that ships inside the app. |
| User view | A view in the owner's data folder. |
| Host | The desktop renderer (`packages/ui`). It holds the daemon connection and shows the view in a frame. |
| Bridge | The message channel between the host and the view's frame. |
| View API | The versioned set of data and calls the bridge carries. This is the public contract. |
| Grant | The owner's recorded consent for one view to use one permission. |
| Slot | A place in the shell where a view can appear. Version 1 has one slot, `page`. |

The View API uses the product's words: a thread is a chat, a project is a workspace, an interaction is a request.

## What exists today

These facts shaped the design. Paths are relative to the repository root.

* The daemon already serves a full local API: JSON-RPC 2.0 over a loopback WebSocket, with `snapshot.get` and a sequenced event stream (`packages/daemon/src/api.ts`, `packages/protocol/src/catalog.ts`). It has about 270 methods and `protocolVersion = 1`.
* That API is not safe to give to a view. One token grants full owner access, the daemon creates a new token on every start, and the methods are internal and change freely.
* The renderer keeps the snapshot and applies events in `packages/ui/src/connection.ts`. Everything a view needs to read is already in that store.
* Artifacts already render untrusted HTML safely: a sandboxed frame on the `zoltbot-artifact:` scheme with a strict Content Security Policy and no network (`apps/desktop/src/artifact-protocol.ts`, `packages/ui/src/artifacts/Artifacts.tsx`). An artifact cannot call back into the app.
* File rules for untrusted bundles exist in `packages/artifact-validation`.
* Agent definitions already work as "built-in, unless a user file with the same id replaces it" (`packages/detect/src/definitions.ts`).
* User data lives in the data folder, outside the app bundle: `~/Library/Application Support/Zoltbot` in a packaged app. Replacing the app does not touch it.
* Nothing watches files today. Routes, the command palette and keyboard shortcuts are hard-coded (`packages/ui/src/state.ts`, `packages/ui/src/shell/`).

## Design overview

```
 view folder (files on disk)
        │  loaded and checked by
        ▼
 daemon: view registry ── records, grants, saved state
        │  file bytes over the authenticated asset route
        ▼
 desktop main: zoltbot-view:// protocol handler (CSP, no network)
        │
        ▼
 sandboxed frame  ◄── bridge (MessagePort) ──►  host (packages/ui)
   the view's code                                 │ existing connection
                                                   ▼
                                                daemon RPC
```

* The daemon owns the view folders, checks them and records grants.
* The desktop main process serves a view's files on a new scheme, with the same protections artifacts have.
* The host shows the view in a frame and opens a bridge to it.
* The view never talks to the daemon. It calls the View API over the bridge. The host checks the grant, then makes the daemon call itself.
* The host builds the View API's data from the snapshot it already has. Phase 1 needs no new daemon data.

## The view folder

```
command-map/
  view.json          manifest (required)
  index.html         entry page
  map.js
  map.css
  vendor/three.min.js
  icon.svg           optional, shown in the sidebar and settings
```

### File rules

A view follows the artifact rules in `packages/artifact-validation`, with these limits:

* Allowed types: `.html`, `.css`, `.js`, `.mjs`, `.json`, `.svg`, `.md`, `.txt`, PNG, JPEG, WebP, plus `.woff2` (new). WebAssembly files are not allowed in version 1.
* At most 500 files, 25 MB per file, 100 MB in total.
* Paths are relative, use `/`, contain no `..`, and differ by more than letter case.
* No symlinks. The loader rejects a folder that contains one. Built-in files may be owned by root after app installation; user files must be owned by the current user. Artifact reads retain their existing owner restriction. The built-in parent path is canonicalized so an installation symlink outside the bundle does not hide the shipped views.
* The path prefix `_host/` is reserved. The host serves the client library there.

### Manifest

`view.json`:

```json
{
  "manifest": 1,
  "id": "command-map",
  "name": "Command map",
  "description": "Your chats as units on a map. Alerts point at the ones that need you.",
  "version": "1.0.0",
  "api": 1,
  "entry": "index.html",
  "icon": "icon.svg",
  "slots": ["page"],
  "permissions": ["read", "act", "approve"],
  "shortcuts": [
    { "id": "next-alert", "keys": "Space", "label": "Go to the latest alert" }
  ],
  "author": "Zolt Labs",
  "license": "Apache-2.0"
}
```

| Field | Required | Rule |
|---|---|---|
| `manifest` | yes | Manifest format version. `1`. |
| `id` | yes | 2 to 40 characters, `a-z`, `0-9`, `-`. Must equal the folder name. |
| `name` | yes | 1 to 40 characters. Shown in the sidebar. |
| `description` | no | Up to 200 characters. Shown in settings. |
| `version` | yes | Semantic version of the view itself. |
| `api` | yes | View API version the view was written for. `1`. |
| `entry` | yes | Path of an `.html` file in the folder. |
| `icon` | no | Path of an `.svg` or `.png` in the folder. |
| `slots` | yes | Where the view can appear. Only `["page"]` in version 1. |
| `permissions` | yes | Any of `read`, `act`, `approve`. `read` is required. |
| `shortcuts` | no | Up to 30 entries. See "Keyboard". |
| `author`, `license` | no | Free text, up to 80 characters each. |
| `basedOn` | no | Written by Customize. See "Customizing a built-in view". |

The loader ignores unknown fields, so a newer manifest still loads in an older app. A manifest whose `api` is higher than the app supports does not load; the settings page names the required View API version and asks the owner to update Zoltbot. The existing code has no mapping from a future View API to an app release, so it does not guess one.

Define the manifest with TypeBox next to the other schemas and generate its JSON Schema the same way `packages/protocol/schema/` is generated.

## Where views live

| Kind | Folder | Who writes it |
|---|---|---|
| Built-in | `views/<id>/` inside the app (in the repository: `packages/views/<id>/`) | Zoltbot releases |
| User | `<data folder>/views/<id>/` | The owner, or an agent on the owner's behalf |

Related files:

* `<data folder>/view-state/<id>.json` holds what the view saved through `storage` (for example control groups). At most 256 KB.
* Grants live in the database, not in the view folder. A view, or an agent that edits a view, must not be able to grant itself anything.

### Precedence

Follow `loadDefinitions` in `packages/detect/src/definitions.ts`:

* A user view with the same `id` as a built-in replaces the built-in. The record says so (`overridesBuiltin: true`).
* A user folder that fails a check does not load and does not replace the built-in. The settings page shows the reason.
* The loader never writes into a user folder except through the actions in "Lifecycle".

### Loading

The daemon loads views at start and on reload:

1. List built-in folders and user folders.
2. For each, read and check `view.json`, then check every file against the file rules and hash it (SHA-256).
3. Compute the bundle hash: SHA-256 of the manifest bytes plus the sorted list of `path:hash` lines.
4. Publish a `view` record (see below) and emit `view.updated` when the bundle hash or the grants change.

The bundle hash names one exact set of files. The frame URL contains it, so a changed view always loads fresh.

### The view record

A new entity kind, `view`, in the snapshot:

```ts
interface ViewRecord {
  id: string;
  source: "builtin" | "user";
  name: string;
  description?: string;
  version: string;
  api: number;
  slots: "page"[];
  bundleHash: string;
  entry: string;
  icon?: string;
  requested: Permission[];          // from the manifest
  granted: Permission[];            // from the database
  reviewed?: Permission[];          // permissions previously shown, including declined ones
  overridesBuiltin: boolean;
  basedOn?: { id: string; version: string; bundleHash: string };
  builtinUpdate?: { version: string; bundleHash: string }; // set when the built-in moved on
  error?: { code: string; message: string; path?: string };  // set when the folder did not load
  enabled: boolean;
  removed?: boolean; // retained projection row after an explicit removal; hidden from installed views
  shortcuts?: { id: string; keys: string; label: string }[]; // for the palette
  changedAt?: string; // newest file modification time, for settings
}
```

### New daemon methods

Add these to `packages/protocol/src/` in a new `views.ts`, and to the Mac-only list in `catalog.ts`, so a phone cannot install or grant.

| Method | Does |
|---|---|
| `view.reload {}` | Loads the folders again. |
| `view.setEnabled {id, enabled}` | Shows or hides a view in the sidebar. |
| `view.call {id, method, params, confirmed?: true}` | Host-only wrapper for view action calls. Rechecks database grants at execution; `confirmed` comes from the host dialog, never from the frame. |
| `view.setGrants {id, permissions, confirmed: true}` | Records the owner's grant. Writes an audit entry. |
| `view.customize {id}` | Copies a built-in to the user folder. |
| `view.resolveUpdate {id, choice: "keep" \| "replace" \| "copy", confirmed?: true}` | Answers a built-in update. |
| `view.import {path, confirmed: true}` | Copies a folder the owner picked into the user folder. |
| `view.remove {id, confirmed: true}` | Permanently deletes a user view after host confirmation and records the confirmation in the audit log. |
| `view.state.get {id}` / `view.state.set {id, value}` | Reads and writes the saved state file. |

Add asset routes next to the artifact ones in `packages/daemon/src/api-assets.ts`: `GET /view-manifest/<bundleHash>` and `GET /view-file/<bundleHash>/<fileHash>`, with the same bearer token and origin checks.

## Lifecycle

### Customizing a built-in view

Customize copies the built-in folder to `<data folder>/views/<id>/` and adds to its manifest:

```json
"basedOn": { "id": "command-map", "version": "1.0.0", "bundleHash": "…" }
```

From then on the user folder is the one that loads. The owner or an agent edits it freely.

### App updates

An update replaces the app and its built-in views. It never changes the data folder.

At start, for each user view with `basedOn`, the daemon compares `basedOn.bundleHash` with the current built-in's bundle hash. When they differ it sets `builtinUpdate` on the record, and the host offers three choices. These are the same choices skills use (`packages/skills/src/library.ts`):

| Choice | Result |
|---|---|
| Keep mine | Nothing changes. `basedOn` moves to the new built-in so the prompt does not repeat. |
| Use the new version | After host confirmation, the user folder is deleted immediately and the confirmation is audited. The built-in loads. |
| Keep both | The user folder is renamed `<id>-custom` (manifest `id` updated). The built-in loads under the original id. |

Keep both uses an available id ending in `-custom` (truncating the original id to fit 40 characters), adding a numeric suffix when that id, a retired record, or its saved state already exists. The original saved state stays and a copy belongs to the renamed view; the new id starts without grants. A renamed fork keeps tracking `basedOn.id`, so later built-in updates still reach it.

Zoltbot does not merge files. A person who wants the new built-in features in their version asks an agent to bring them over; "Keep both" gives the agent both folders to compare.

A user view without `basedOn` (written from scratch or imported) is never prompted.

### When the View API changes

* Version 1 only gains optional fields, new topics and new calls. A view must ignore fields it does not know.
* A breaking change makes version 2. The host keeps serving version 1 to views that ask for it for at least two minor releases of Zoltbot after version 2 ships, and the settings page marks those views.
* The internal daemon protocol can change at any time. The mapping in "From Zoltbot's data to the View API" is the only code that needs to follow it.

### Reload while editing

The daemon watches `<data folder>/views/` (one recursive `fs.watch`, changes collected for 300 ms) and reloads. The host replaces the frame when the bundle hash changes. A reload button on the view's header does the same on demand. Built-in folders are not watched.

### Removing

Remove permanently deletes the user view immediately after explicit confirmation in the host, outside the frame. The confirmation states that the customized files will be lost and is recorded in the audit log (I13). There is no removed-view folder, retention timer or Restore action. The existing event projector retains entity rows, so an explicitly removed standalone view keeps a `removed` tombstone and is hidden from installed views; a missing folder still appears as a load error. Removing an override reveals the built-in view. Saved state survives removal. The "Use the new version" update choice has the same confirmation and audit requirement; `view.resolveUpdate` requires `confirmed: true` for `replace`.

## Rendering and isolation

### Scheme

Register a third privileged scheme in `apps/desktop/src/main.ts`, next to `zoltbot-artifact`:

```
zoltbot-view://<bundleHash>/<path>
```

Write `apps/desktop/src/view-protocol.ts` following `artifact-protocol.ts`:

* Fetch the manifest and files from the daemon's asset routes with the bearer token.
* Check every file's hash and size on every request.
* Serve `_host/v1/zolt.js` (the client library) from the app, not from the view folder.
* Refuse any path not listed in the bundle.

### Response headers

```
Content-Security-Policy:
  default-src 'none';
  script-src <bundle origin> 'unsafe-inline';
  style-src <bundle origin> 'unsafe-inline';
  img-src <bundle origin> data: blob:;
  font-src <bundle origin>;
  media-src <bundle origin> blob:;
  worker-src <bundle origin> blob:;
  connect-src <bundle origin>;
  form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none';
  frame-ancestors <ui origin>
X-Content-Type-Options: nosniff
Cache-Control: no-store
Referrer-Policy: no-referrer
```

Differences from artifacts: views may start workers, because games need them. WebAssembly stays blocked in version 1. `connect-src` allows only the view's own files, so `fetch("levels.json")` works and no other address does.

### Frame

```html
<iframe sandbox="allow-scripts" referrerpolicy="no-referrer"
        allow="autoplay; fullscreen 'none'; camera 'none'; microphone 'none'; geolocation 'none'"
        src="zoltbot-view://<bundleHash>/<entry>"></iframe>
```

* No `allow-same-origin`: the frame has no cookies, no `localStorage`, and cannot read the host. A view saves state through `storage`.
* No `allow-popups`, `allow-forms`, `allow-top-navigation` or `allow-downloads`.
* Extend the `webRequest.onBeforeRequest` and `will-frame-navigate` rules in `main.ts`: a view frame may load only its own bundle, a view URL may not load as a main frame, and a view may not navigate to another view or to an artifact.
* Add `zoltbot-view:` to `frame-src` and `img-src` in `packages/ui/index.html`; sidebar and settings icons load from the same checked bundle.
* The preload API stays closed to frames (`verifyMainFrame`). Do not change that.

### Misbehaving views

* If the view sends no `hello` within 10 seconds, the host shows "This view did not start" with Reload and Open settings.
* If the frame's renderer crashes or stops answering a ping for 15 seconds, the host shows the same message. The rest of the app keeps working.
* The host drops bridge messages over 256 KB and limits each view to 50 calls per second. A view that exceeds the limit gets `rate_limited` errors.

### Keyboard

Focus inside a frame sends key presses to the frame, so the app's own shortcuts stop working there. Rules:

* The client library forwards a fixed set of app shortcuts to the host, which handles them as usual: Cmd+K (command palette), Cmd+B (sidebar), Cmd+I (Needs you), Cmd+J (quick chat), Cmd+comma (settings). A view cannot take these over.
* A view handles any other key itself while it has focus.
* Shortcuts declared in the manifest appear in the command palette as "<view name>: <label>". Choosing one sends a `shortcut` event to the view.
* Escape, pressed twice within one second, moves focus from the frame to the sidebar. This is the keyboard way out.

## The bridge

### Handshake

1. The host creates the frame and a `MessageChannel`.
2. When the frame fires `load`, the host posts `{zolt: "connect", api: [1]}` to the frame's window with one port transferred. The target origin is `*` because a sandboxed frame has no origin to name; the message carries no secret.
3. The client library receives the port and sends `{t: "hello", api: 1}` on it.
4. The host answers `{t: "ready", …}` with the session facts below. All later messages use the port.

The host accepts messages only on the port it created. It ignores window `message` events from frames.

### Messages

```ts
// view → host
{ t: "hello", api: 1 }
{ t: "call", id: number, method: string, params?: unknown }
{ t: "sub", topics: Topic[] }
{ t: "unsub", topics: Topic[] }
{ t: "key", combo: "mod+k" }                    // forwarded app shortcut

// host → view
{ t: "ready", api: 1, view: {id, name, version}, granted: Permission[],
  theme: Theme, locale: string, reducedMotion: boolean, mock: boolean }
{ t: "result", id: number, ok: true, value?: unknown }
{ t: "result", id: number, ok: false, error: { code: string, message: string } }
{ t: "data", topic: Topic, value: unknown, at: string }
{ t: "event", name: "theme" | "grants" | "shortcut" | "visibility", value: unknown }
```

Data delivery is simple on purpose: when a topic changes, the host sends that topic's whole value, at most 10 times per second per topic. Version 1 sends no diffs. With a few hundred chats a full value is tens of kilobytes.

### Error codes

| Code | Meaning |
|---|---|
| `not_granted` | The view lacks the permission this call needs. |
| `declined` | The owner said no in a confirmation the host showed. |
| `not_found` | The chat or request does not exist any more. |
| `stale` | The request changed since the view read it. Read it again. |
| `invalid` | The parameters failed validation. |
| `rate_limited` | Too many calls. |
| `unavailable` | The daemon is offline or the call failed there. `message` has detail. |

## View API version 1

Ship the types in a new public package, `packages/view-api`, with generated JSON Schema. Run `pnpm view:schema` to regenerate its manifest, topic, call and bridge schemas. Request context omits `cwd` and `paths` to honor the version 1 decision below. The bridge also uses `ping` and `pong` messages with a numeric `id` for liveness checks; the fixed key list includes `escape-exit` for the double-Escape exit.

### Permissions

| Permission | Allows |
|---|---|
| `read` | Subscribe to every topic. Use `storage`, `app.open`, shortcuts. |
| `act` | `chats.send`, `chats.interrupt`. |
| `approve` | `requests.answer`. |

### Topics

```ts
type Topic = "chats" | "requests" | "workspaces" | "usage" | "checks";

interface Chat {
  id: string;
  title: string;
  kind: "main" | "task" | "side" | "manager";
  /** Where the chat sits in the inbox. "idle" means read and not running. */
  status: "needs_you" | "working" | "review" | "later" | "settled" | "idle";
  /** Set when the session has a problem the owner should know about. */
  problem?: { kind: "auth_required" | "rate_limited" | "error" | "reconnecting"; detail?: string };
  lastTurn?: { status: "running" | "completed" | "failed" | "interrupted"; endedAt?: string };
  /** One line about what the agent is doing now, when known. */
  activity?: string;
  profile: { id: string; name: string };
  provider: { id: string; name: string };          // for example "claude", "Claude Code"
  workspaceId?: string;
  worktree?: { id: string; kind: "folder" | "worktree"; branch?: string; baseRef?: string };
  parentChatId?: string;                            // for delegated work
  requestIds: string[];                             // pending requests, oldest first
  startedAt: string;
  updatedAt: string;
  usage: { costUsd?: number; inputTokens: number; outputTokens: number };
}

interface Request {
  id: string;
  version: number;                                  // pass back when answering
  chatId: string;
  type: "approval" | "question" | "plan" | "form" | "gate";
  title: string;
  urgency: "blocking" | "background";
  createdAt: string;
  /** What the owner needs to decide. Present for approvals. */
  context?: { markdown?: string; tool?: string; command?: string };
  /** Ways to answer. A view shows these; it does not invent its own. */
  choices: { id: string; label: string; widens: boolean }[];
  /** Present for questions and forms. */
  questions?: { id: string; label: string; options?: { id: string; label: string }[]; freeText: boolean; multi?: boolean; schema?: unknown }[];
  answerInChat?: boolean;                           // at least one question uses private input
}

interface Workspace {
  id: string;
  name: string;
  roots: { label: string; isRepository: boolean }[];   // no file paths in version 1
}

interface Usage {
  today: { costUsd: number; costKnown: boolean; inputTokens: number; outputTokens: number };
  budget?: { limitUsd: number; period: "day" };
  activeChats: number;
}

interface Check {                                   // pull request checks
  chatId: string;
  name: string;
  state: "pending" | "passing" | "failing" | "skipped";
  required: boolean;
}
```

Left out of version 1 on purpose: message text and tool output from the chat history, file contents and diffs, file system paths, knowledge, settings, devices and connections. A view links to the chat for those (`app.open`).

### Calls

```ts
// read
zolt.subscribe(topics: Topic[], onData: (topic, value) => void): () => void
zolt.storage.get(): Promise<unknown>
zolt.storage.set(value: unknown): Promise<void>          // whole value, JSON, 256 KB at most
zolt.app.open(target: { chatId: string } | { page: "needs-you" | "overview" | "settings" }): Promise<void>

// act
zolt.chats.send(input: { chatIds: string[]; text: string }):
  Promise<{ chatId: string; result: "started" | "queued" | "skipped"; reason?: string }[]>
zolt.chats.interrupt(input: { chatIds: string[] }):
  Promise<{ chatId: string; result: "interrupted" | "skipped"; reason?: string }[]>

// approve
zolt.requests.answer(input: {
  requestId: string; version: number;
  choiceId?: string;                                     // approvals, plans, gates
  answers?: Record<string, string | string[] | {options?: string[]; other?: string} | { value: unknown }>;           // questions and forms
  feedback?: string;
}): Promise<void>
```

Question strings select a matching option id or supply an Other answer; arrays select multiple option ids. `{options, other}` allows the existing multiple-choice question format to combine selected options with Other text. Forms use `{value}` with the existing flat form schema, exposed as `questions[].schema`; `multi` follows the existing interaction item. Other text is allowed unless `allowOther` is explicitly false, matching the existing answer validator. `answerInChat` marks requests containing private input. Secret questions remain in the host chat and cannot be answered through a view. These shapes follow the existing interaction handler rather than inventing a second form format.

Limits: `chatIds` holds 1 to 50 ids, `text` at most 8,000 characters.

### From Zoltbot's data to the View API

Write this as pure functions in `packages/view-api/src/model.ts`, taking the renderer's snapshot and returning topic values. Test them with fixture snapshots.

| View API | Source |
|---|---|
| `Chat.status` | `threadMailbox` in `packages/protocol/src/inbox.ts`; `undefined` becomes `"idle"` |
| `Chat.problem` | the session's `RuntimeStatus` (`packages/protocol/src/entities.ts`) |
| `Chat.lastTurn` | newest `turn` for the thread |
| `Chat.activity` | Newest running tool item's `body.title` or plan item's in-progress `body.entries` step in a running turn. The renderer snapshot holds projected items, not raw `tool.started` events. |
| `Chat.profile`, `provider` | `agent` and `agentDefinition` entities |
| `Chat.worktree` | `workspace` entity for the thread |
| `Chat.usage` | `usage` records summed by thread |
| `Request` | `interaction` entities with `state: "pending"` |
| `Request.choices[].widens` | true for `allow_session`, `allow_accept_edits`, `allow_rule`, `reject_rule` |
| `Workspace` | `project` entities |
| `Usage.today` | `usage` records since local midnight |
| `Usage.budget` | `settings` key `budget.day.<UTC date>` with `value.usd`, as stored by `budget.set`. The existing budget engine supports daily owner budgets, not monthly ones; token-only budgets have no USD limit. Otherwise absent. |
| `Check` | `checks[]` in the shipping snapshot (`packages/protocol/src/shipping.ts`) |
| `chats.send` | `turn.send {threadId, input, mode: "queue"}` per chat |
| `chats.interrupt` | `turn.interrupt {threadId, turnId}` for the running turn; `skipped` when none runs |
| `requests.answer` | `interaction.answer {id, version, answer}` |
| `app.open` | the host's existing navigation |

### Rules for answering requests

Architecture invariant I13 says an action that widens a permission needs explicit human confirmation recorded in the audit log. A click inside a view is not enough for that, because the view controls what the button says. So:

* With the `approve` grant, a view answers directly when the choice has `widens: false` (allow once, reject once, plan and gate answers) and when it answers a question or form.
* When the choice has `widens: true`, the host shows its own confirmation, outside the frame, with the request's real title, command and the choice's label. The call resolves after the owner confirms, or fails with `declined`.
* The host passes the `version` through. If the request changed, the call fails with `stale`.
* Every answer sent through a view records which view sent it. `ResolutionSchema` (`packages/protocol/src/interactions.ts`) gains an optional `via: { kind: "view"; id: string }`, and the audit entry includes it.

### Rules for sending messages

`act` is a strong permission. A message can tell an agent to do anything that agent is allowed to do, including send data out, which the view itself cannot. The grant dialog says so in plain words (see "Grants"). The host also records an audit entry for each `chats.send` with the view id, the chat ids and the text's length.

## Grants

* A view starts with no grants. Without `read` it does not load.
* The first time the owner opens a view, the host shows one dialog listing what the view asks for:

| Permission | Text in the dialog |
|---|---|
| `read` | See your chats, workspaces, pending requests and spending. |
| `act` | Send messages to your agents and stop them. Agents act on these messages as if you wrote them. |
| `approve` | Answer approvals and questions for you. Zoltbot still asks you before anything that allows more than one action. |

* The owner can grant `read` alone. A view must work with fewer permissions than it asked for: the client library exposes `zolt.granted`, and calls it lacks fail with `not_granted`.
* Built-in views go through the same dialog. A built-in is not trusted more than a user view.
* Grants are stored per view id in the database (new migration, table `view_grants(view_id, permission, granted_at)`). `view_reviews(view_id, requested)` remembers which permissions the owner already reviewed, so declining a requested permission does not cause another prompt on every open. Neither table is writable through the bridge.
* If a later version of the manifest asks for a permission the owner has not granted, the host asks again for that permission only.
* Editing a user view's files does not clear its grants. The owner controls that folder, and asking again after every edit would make editing unusable. The settings page shows when the files last changed.
* `view.import` always starts with no grants, even when a previously deleted view had the same id.
* The settings page lists every view with its grants and a switch for each.

## Host services

### Theme

`ready.theme` and the `theme` event carry:

```ts
interface Theme {
  scheme: "light" | "dark";
  tokens: Record<string, string>;   // semantic --zb-* tokens with resolved values
  fontSans: string; fontMono: string; fontScale: number;
}
```

The client library writes the tokens onto the view's root element as CSS custom properties, so a view styles itself with `var(--zb-bg-page)` and follows the app's appearance. The host sends the semantic tokens from `packages/tokens/tokens.css` (surfaces, borders, text, accent, status, provider marks, radii, spacing), not the primitives. The app's fonts are not available inside the frame; a view that wants them ships the font files.

### Saved state

The internal `view.state.get` result is `{value}` and `view.state.set` returns `{ok:true}`, following the daemon dispatcher’s object-result convention; the client library still returns the bare saved value or void.

`storage.get` and `storage.set` read and write `<data folder>/view-state/<id>.json` through the daemon. One JSON value per view. It survives reloads, edits and app updates. "Keep both" copies it to the renamed view.

### Sound

A view plays sound with Web Audio after the owner has clicked or pressed a key inside it. Zoltbot's own notification sounds are not part of the View API.

### Visibility

The host sends a `visibility` event when the view's page is shown or hidden. A hidden view should stop its animation loop. The host stops delivering `data` to a hidden view and sends the current values when it is shown again.

## The client library and mock mode

`_host/v1/zolt.js` is a small script the host serves. A view includes it first:

```html
<script src="_host/v1/zolt.js"></script>
<script>
  zolt.ready.then(({ granted, theme }) => {
    zolt.subscribe(["chats", "requests"], (topic, value) => render(topic, value));
  });
</script>
```

It does the handshake, turns calls into promises, applies theme tokens, forwards app shortcuts, and exposes `zolt.granted`. `zolt.on(name, callback)` listens for `theme`, `grants`, `shortcut` and `visibility` events and returns an unsubscribe function.

Mock mode makes a view usable in an ordinary browser, with no app:

* When the page is not inside Zoltbot (no `connect` message within 300 ms and the page is the top window), the library loads sample data and runs a small simulation: chats change status, a request appears, spending rises. Calls succeed and change the sample data.
* `ready.mock` is `true`, so a view can show a "Sample data" label.
* The simulation and sample data live in `packages/view-api/mock/`. `pnpm view:dev <folder>` serves them, the client and theme tokens virtually under `_host/v1/` while serving the checked view folder on loopback. It does not copy host files into the view: `_host/` is reserved and would make that folder invalid.

The simulation in the command map prototype (`docs/prototypes/command-map.html`) is the starting point for the mock.

## In the shell

* **Route:** add `View` to the `Route` union in `packages/ui/src/state.ts`, with the view id in the hash (`#view/<id>`). `ViewPage` in a new `packages/ui/src/views/` renders the header (name, Reload, Settings) and the frame.
* **Sidebar:** enabled views with the `page` slot appear in a "Views" group under the main routes, by name, with their icon.
* **Command palette:** one entry per enabled view ("Open <name>"), plus each view's declared shortcuts while it is open.
* **Settings:** a new "Views" tab lists built-in and user views with: enabled switch, grants, version, source, "Customize", "Show in Finder", "Reload", "Remove", any load error, and any pending built-in update.
* **Empty and error states:** a view that failed to load shows the loader's reason and the file path it concerns. Write this copy with `skills/clean-copy` and `DESIGN.md`.

Keep each new module under the 800-line limit (invariant I14).

## The built-in command map

Folder: `packages/views/command-map/`. It asks for `read`, `act` and `approve` and must work with `read` alone.

| Prototype feature | Built on |
|---|---|
| Regions | `workspaces`. Chats with no workspace go in an "Other" region. |
| Bases | One per `Chat.worktree`. Chats sharing a folder share a base. |
| Units | `chats` with status `needs_you`, `working`, `review`, or active in the last 24 hours. `settled` chats are not drawn. |
| Unit states | working: `working`. Needs you: `needs_you`. Done (flag): `review`. Idle: `idle` or `later`. A failed last turn or a `problem` shows a warning mark. |
| Edge alerts | Chats with `needs_you` that are off screen. Clicking one moves the camera and selects it. |
| Request panel | `requests` for the selected chat, using each request's `choices` and `questions`. Hidden without `approve`; an "Open chat" button takes its place. |
| Orders | Editable presets, each a message sent with `chats.send` to every selected chat. Defaults: "Rebase on main", "Run the tests". Stop is `chats.interrupt`. Hidden without `act`. |
| Control groups | Saved with `storage`. |
| Resource bar | `usage`: spend today against the budget, active chats, count of requests. Failing required `checks` replace the prototype's CI minutes, which Zoltbot does not track. |
| Layout | Positions are computed from the data (regions packed by size, bases on a grid). The owner can drag a region; positions are saved with `storage`. |
| Minimap, zoom, box select | As in the prototype. |

three.js ships in the folder (`vendor/`), pinned, with its license file.

The map needs a design pass before it ships. Follow `DESIGN.md`, use the theme tokens, respect `reducedMotion`, and give every state a shape or mark as well as a color. A list of chats in the side panel remains the keyboard and screen-reader path to everything the map shows.

## Having an agent write or change a view

Most people will ask an agent: "make my map look like a factory".

* **Skill:** ship a skill, "Building Zoltbot views", that explains the folder, the manifest, the View API, the theme tokens and mock mode. It is the first built-in skill; `packages/skills` has no built-ins today, so this adds that concept.
* **Host tool:** add a host MCP tool `team_view` (in `packages/daemon`, next to `team_artifact` in `artifacts/tools.ts`) with actions `list`, `read` and `save`. `save` takes files staged under `<cwd>/.zoltbot/staging/<uuid>`, checks them as the loader does, and writes them to the user views folder. Agents do not get direct write access to the data folder.
* **Consent:** `save` on a view the agent did not create in this chat raises a request to the owner first, showing which files change. Saving never changes grants.
* **Result:** the watcher reloads the view, and the agent's reply links to it (`#view/<id>`).

The first built-in skill registers in the existing skill library with source `builtin:building-zoltbot-views`. It is available for the existing owner-confirmed assignment flow; registration does not enable it for any agent. Owner edits, same-name user skills and removal survive restart. Packaged builds carry the canonical skill folder as a source-relative resource.

`team_view` uses the current host-tool authorization and frozen launch manifest. Browser sessions, forks and read-only profiles cannot save. `read` pages checked source without passing large unchanged libraries through agent context. Existing saves require `baseHash` and overlay only staged changed/new files onto that checked bundle; this adapts the original full-folder wording to the existing bounded source-reading and staging model. The host copies unchanged assets itself, validates the complete result, freezes its bytes and checks the base again before applying. The tool does not delete files from an existing bundle.

Protected `view.origin.<id>` settings record which chat created a view. Import, removal, Customize and replacement clear that origin; Keep both transfers it to the renamed view. Protected `view.proposal.<uuid>` settings retain actor, hashes and changed paths for durable approval, with proposed bytes in an app-owned hidden staging folder. The existing settings API blocks all `view.*` keys from ordinary clients. Host approval uses the existing interaction engine and can finish after the proposing turn ends. These records add no columns or changes to existing tables.

## Slots: changing more than one page

The owner wants to start with full-page views and later let people change other parts of the app, such as the sidebar. The manifest's `slots` field is how that grows without a new format.

Planned order, each a separate piece of work:

| Slot | What it is | Notes |
|---|---|---|
| `page` | A full page with a sidebar entry. | This plan. |
| `home` | Replaces the Overview page. | A setting that picks which `page` view opens first. Small. |
| `panel` | A panel beside a chat. | Needs a `chat` context in `ready` and per-chat topics. |
| `status` | A strip at the bottom of the window. | Fixed height; read-only views only. |
| `sidebar` | A section in the sidebar. | See below. |

For the sidebar, start with settings before code: let the owner reorder, hide and group the existing entries, stored in a file (`<data folder>/shell.json`) that follows the same "built-in defaults, user file wins, updates never overwrite" rule as views. That covers most requests and keeps navigation accessible and fast. A `sidebar` slot that runs view code comes after, for sections that need live data, and it will have a fixed width and height budget.

Rules that hold for every slot: the same bridge, the same permissions, and the app's own navigation and the Needs you page always remain reachable, whatever a view does.

## Later work

* **Clients outside the app.** A scoped token the owner creates in settings (permissions as above, revocable, stored hashed), accepted by the daemon's WebSocket for a small set of methods that serve the View API's topics and calls. This moves the mapping in `packages/view-api` into the daemon. It needs its own security review.
* **Views in a repository.** `.zoltbot/views/` shared with a team. Loading code from a cloned repository needs a trust prompt per repository.
* **Turning an artifact into a view.** An agent already produces HTML as artifacts; a "Use as view" action could wrap one.
* **Phone.** The same folder in a web view, with the bridge carried over the existing encrypted link.

## Security review

| Risk | Protection |
|---|---|
| A view reads the owner token. | The frame is sandboxed without `allow-same-origin` and has no preload API. The token never crosses the bridge. |
| A view sends code or chat data to a server. | The Content Security Policy and the request filter block every address except the view's own files. No popups, forms or navigation. |
| A view sends data out through an agent. | Needs `act`. The grant text says agents act on its messages. Each send is audited. |
| A view approves a dangerous command. | Needs `approve`. Choices that allow more than one action go through the host's own confirmation. Every answer records the view. |
| A view mislabels a button to trick the owner. | The host's confirmation for widening choices shows the request's real text. Risk remains for allow once; the grant dialog states it. |
| An agent edits a view to grant itself more. | Grants are in the database and change only through `view.setGrants`, which is Mac-only and confirmed by the owner. |
| A view freezes or crashes. | Site isolation puts it in its own process. The host detects silence and offers Reload. |
| A malformed folder. | The loader applies the artifact file rules, rejects symlinks and oversized files, and falls back to the built-in. |
| A downloaded view. | `view.import` starts with no grants (including when reusing a removed id), strips imported `basedOn` metadata, and shows the manifest's permissions before first use. |
| Secrets in view state. | A view never receives secrets. Invariant I7 holds: the View API carries none. |

Checks against the architecture invariants: I1 (the daemon and agents do not depend on any view), I5 (a view answers the durable Interaction record, it does not replace it), I7, I13 and I14 as noted above.

## Build phases

Each phase ends with something usable. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:ui` and `pnpm build:desktop` before each push. Browser tests stay headless.

### Phase 1: a read-only view inside the app

1. `packages/view-api`: manifest schema, topic types, bridge message types, `model.ts` with tests on fixture snapshots, generated JSON Schema.
2. `packages/daemon/src/views/`: loader (checks, hashing, precedence), `view` entity and `view.updated` event, `view.reload`, `view.setEnabled`, asset routes. Tests: valid folder, each rejection, user replaces built-in, broken user folder falls back.
3. `apps/desktop/src/view-protocol.ts` and the scheme registration, request filter and navigation rules. Tests in the style of the artifact protocol tests: headers, hash mismatch, path outside the bundle, cross-view request blocked.
4. `packages/ui/src/views/`: `ViewPage`, the frame, the host side of the bridge (handshake, `sub`, `data`, theme, visibility, limits), route, sidebar group, command palette entry.
5. `_host/v1/zolt.js` with the handshake, `subscribe`, theme tokens and shortcut forwarding.
6. `packages/views/command-map/`: the prototype (`docs/prototypes/command-map.html`) ported to the View API, read-only, with three.js vendored into the folder. Clicking a unit opens its chat.

Done when: with real chats running, the map shows them in the right states, an off-screen chat that needs you raises an edge alert, the frame makes no network request, and removing the built-in folder's `read` grant unloads the view.

`app.open` is introduced with the read-only host in phase 1 so clicking a map unit can open its chat; phase 2 adds the action handlers.

### Phase 2: actions and grants

1. Migration for `view_grants`; `view.setGrants`; the grant dialog; the settings tab.
2. Bridge calls `chats.send`, `chats.interrupt`, `requests.answer`, `app.open`, with permission checks, the host confirmation for widening choices, `via` on resolutions, and audit entries.
3. `storage` and the state file; manifest shortcuts in the command palette; the Escape exit.
4. Command map: request panel, orders with editable presets, control groups, saved layout.

Done when: every call fails with `not_granted` without its grant (tested per call), a widening choice cannot complete without the host dialog, and an answered request's audit entry names the view.

### Phase 3: customizing

1. `view.customize`, `basedOn`, the built-in update prompt and `view.resolveUpdate`.
2. The folder watcher and reload in place.
3. `view.import` and confirmed, audited immediate deletion with `view.remove`.
4. Mock mode, `pnpm view:dev`, and a public guide (`docs/building-views.md`) with a minimal example view.
5. The "Building Zoltbot views" skill and the `team_view` tool.

Done when: a person can press Customize, ask an agent to change the map's colors, see the change without restarting, install a build with a newer built-in map, and still have their version with a working prompt for each of the three choices.

### Phase 4: design pass on the command map

Visual design, motion, sound and accessibility review of the built-in map. Not a dependency of phases 1 to 3.

## Decisions on open points

These were open while planning. Each has a decision for version 1.

| Point | Decision | Why |
|---|---|---|
| WebAssembly in views | Not allowed. No `.wasm` files and no `wasm-unsafe-eval`. | The command map does not need it. Allowing it later is an additive change; removing it later would break views. |
| Chat text in the View API | Not included. | A view that can read every message is a much larger grant than one that sees statuses. Add a `history` topic behind a fourth permission when a view needs it (replay, speech bubbles). |
| File paths | Not included. `Workspace.roots` carries labels only. | Same reason. Fog of war needs touched files; it comes with the `history` permission. |
| Budget in the resource bar | Show the owner-level budget from `budget.set` when one is set. With none, show spend with no limit. Do not serve `limits.*` for this. | Uses what the daemon already stores. Check the stored shape in `packages/core/src/budgets.ts` before mapping it, and update the `Usage` type here if it differs. |
| Where `Chat.activity` is computed | In the host, in `packages/view-api/src/model.ts`. | No daemon change in phase 1. Move it into the daemon when clients outside the app or the phone need the same line. |
| The prototype | Committed at `docs/prototypes/command-map.html`. | It is the reference for the built-in map's behaviour. It uses sample data and loads three.js from a CDN; the built-in view vendors three.js instead. |
