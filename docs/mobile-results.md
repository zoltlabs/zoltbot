# Results on the phone

The chat toolbar opens **Results** without scrolling through the conversation. The same
screen is available from the Inbox. It gathers the current task outcome, artifacts, links
from agent replies, latest-turn file changes, outstanding requests, and delegated work.
Task review opens the existing Tasks screen. Completed ordinary chats offer Archive.
Completion and provider waiting states use the desktop selectors, including usage limits,
sign-in, reconnecting, background work, and unresolved message delivery.

## Saved versions

Open an artifact to inspect saved versions. Baseline and alternative are stacked vertically;
each has an explicit version selector. Held and missing versions remain identified, with
previews and selection unavailable. Available text and Markdown documents render as native
text. HTML and supported images show a static first-screen preview rendered on the Mac at
390 × 780. Interactive content and the full canvas remain available on Mac.

**Use baseline** or **Use alternative** prepares an unsent message and pins its exact
artifact and version IDs. Optional feedback is included. Existing composer text is preserved,
and the handoff is consumed once. Sending a version reference always queues the message;
it never steers an active turn. Version selection requires the same ordinary-chat revision
support as desktop. Inspecting a version does not accept a task or publish anything.

## Preview transport

Both devices need the updated code. `artifact.phonePreview` takes an artifact ID and an
explicit version ID over the existing authenticated, encrypted link. It does not expose a
file server or send source bundles to the phone. Old Macs without the method show the
preview error and retry state.

The daemon checks version ownership, archive, held, and file availability. Native text is
limited to 64 KiB. Raster previews use an isolated headless browser with service workers
and downloads disabled. Requests can reach only the selected bundle and packaged artifact
kit; other origins and local files are blocked. Images are limited to 256 KiB before base64
encoding to fit the encrypted link. Rendering is serialized with a bounded queue, and the
browser closes on success or failure. Browser support must be installed through the Mac's
existing browser setup. Offline phones retain metadata and can load previews after reconnecting.

## Verification

Mobile data tests cover condition forms, dependency scope, completion/provider states,
version eligibility, and single-use drafts. Daemon preview tests cover exact versions,
held/missing/foreign versions, request blocking, and browser cleanup. iOS export verifies
Metro bundling. A headless browser can verify layout with substituted native primitives,
but native rendering, Dynamic Type, and VoiceOver still need a device or isolated simulator
run following the repository's desktop authorization rules.
