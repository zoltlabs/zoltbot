# Managed skills

Skills are reviewed copies of local folders. Import is read-only, bounded, and never runs scripts. `SKILL.md` must contain safe YAML with a lowercase name and a nonempty description, followed by Markdown instructions. Supported metadata is name, description, license and compatibility. Native permission/model/tool/hook directives and dynamic shell substitutions are rejected. This is deliberately narrower than arbitrary provider plugins.

The parser rejects symlinks, traversal, special files, binary/invalid UTF-8 content, install configuration, likely credentials and credential-bearing reference URLs. Limits: 100 files, 256 KB per file, 1 MB total, 64 KB instructions, eight directory levels. Scripts remain plain text during import. Agents can run them only through their normal permissions and approval flow. Import does not install dependencies.

Every edit creates an immutable revision. Source updates are explicit: keep the local version, replace it while retaining history, or create a separately named copy. Removed entries disappear from assignments; old revisions are retained for resumable sessions. A removed name can be imported again without changing the former entry. No automatic garbage collection is implemented, so retained revisions consume local database space.

Access is explicit per profile and scope, with an audited confirmation when enabled. Profile assignments pin a revision; editing alone does not silently change that pin. Choose **Use vN for new sessions** to update it. A narrower scope can explicitly disable an inherited skill. Native built-in command names are reserved. Managed Claude skills additionally have a hash-derived namespace, so they cannot replace native commands.

The connections-owned LaunchManifest freezes id/revision/hash and a logical path before provider open. Selection is revalidated in the intent transaction. Existing native sessions always reuse their saved manifest. Materialization occurs afterward in the daemon's private runtime directory, deterministically keyed by manifest id. Resume verifies or reconstructs the same read-only files, including after library edits/removal. No skill files, provider configuration or ignore rules are written into a user's checkout or global skill folders.

## Native compatibility

- **Claude Code:** session-scoped `--plugin-dir`, generated app-owned plugin manifest and `skills/<name>/SKILL.md`. Invocation uses the provider-reported `zoltbot-<content hash>:<name>` command. Open fails if the provider does not report it in its native catalog. The original provider command catalog is preserved and managed skills are displayed separately.
- **Codex:** managed loading unavailable. The installed app-server schema exposes native skill input but no extra loading-root option. `skills.config` is a selection setting, not verified evidence of arbitrary managed-folder loading. No global folder writes or prompt fallback are used.
- **ACP and other adapters:** unavailable unless the adapter advertises a verified native route.

Selected unsupported skills block dispatch; remove the selection or choose a supported profile for a new execution. Import and editing are still available. Native invocation and native reads remain provider-owned. The launch budget reserves a conservative estimated metadata/wrapper cost (UTF-8 bytes divided by three, plus a 512-byte reserve per selected skill), separately from provider-measured token usage.

Sources: [Claude plugin manifest reference](https://code.claude.com/docs/en/plugins-reference), [OpenAI skills documentation](https://learn.chatgpt.com/docs/build-skills), installed CLI help and generated app-server JSON schema.

## Verification

Focused tests cover malformed/unsafe frontmatter, secrets, size limits, traversal/symlinks, script nonexecution, revision conflicts, namespace conflicts, scoped/profile access, explicit inherited disable, removal/reimport, frozen resume, materialization tampering, source-review fencing, idempotent receipts and accessible version diffs. `e2e/skills.spec.ts` exercises the real Electron Settings UI, import/edit/history/remove, keyboard dialog recovery, error states and axe in light/dark.

2026-11-04 live read-only Claude canary: the installed provider reported `zoltbot-canary:zolt-skill-canary` in its native skills and slash-command catalogs and returned exactly `ZOLTBOT_NATIVE_SKILL_CANARY_48` on invocation. Tools were disabled and conversation persistence was disabled. Local evidence: `.cache/skills-native-canary/claude-live.jsonl`; no credential values are included in this README.

Mobile protocol can read library/history/context and change scoped access through the same authenticated API. Local folder detection/import/source refresh are Mac-only. Mobile task cards inspect frozen skills and can disable them for future sessions. Dedicated mobile library/editor screens and a source-result promotion editor remain UI gaps; the desktop editor can receive copied user-authored instructions. No full mobile parity is claimed.
