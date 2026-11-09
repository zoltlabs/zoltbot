# Pi adapter

Work in progress against the verified Pi 1.4.0 RPC and extension API. Real startup, MCP registration, and tool gate recordings live under fixtures/pi/1.4.0. The deterministic local completion server exercises the real Pi tool loop without paid inference. Authenticated provider checks remain pending.

The native wire fake and 22 shared conformance cases cover queueing, steering, interruption, approvals, tools, usage, compaction, crashes, malformed frames, environment hygiene, and authenticated host calls. Focused tests cover gate policy, symlink boundaries, RPC framing, hash verification, exclusive native writers, replayed tool loops, and the real bundled gate recording. Run `python3 tools/canary/pi-local.py` after installing Pi inside the repository. This uses a local deterministic completion server and creates no external model spend.

Install Pi 1.4.0 in an isolated repository folder, with no global install or external configuration, from the repository root:

```sh
mkdir -p .cache/spikes/pi-cli .cache/spikes/pi-home .cache/spikes/tmp
TMPDIR="$PWD/.cache/spikes/tmp" pnpm --dir .cache/spikes/pi-cli --ignore-workspace add --ignore-scripts --save-exact @earendil-works/pi-coding-agent@1.4.0 --store-dir "$PWD/.cache/pnpm/store" --cache-dir "$PWD/.cache/pnpm/cache"
```
