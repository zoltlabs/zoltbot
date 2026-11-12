import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeTarget } from "../targets/fake/index.js";
import {
  type OperationJournal,
  type OperationRecord,
  type OperationRequest,
  SandboxOrchestrator,
} from "./index.js";

class Journal implements OperationJournal {
  readonly rows = new Map<string, OperationRecord>();
  inTransaction = false;
  fail: "before_bound" | "after_bound" | undefined;
  async reserve(record: OperationRecord) {
    if (!this.rows.has(record.key)) this.rows.set(record.key, structuredClone(record));
    return structuredClone(this.rows.get(record.key) as OperationRecord);
  }
  async compare(key: string, version: number, next: OperationRecord) {
    this.inTransaction = true;
    try {
      if (this.rows.get(key)?.version !== version) return undefined;
      const fail = next.state === "bound" ? this.fail : undefined;
      if (fail) this.fail = undefined;
      if (fail === "before_bound") throw new Error("synthetic_storage_failure");
      this.rows.set(key, structuredClone(next));
      if (fail === "after_bound") throw new Error("synthetic_storage_reply_lost");
      return structuredClone(next);
    } finally {
      this.inTransaction = false;
    }
  }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sandbox-orchestration-"));
  const target = createFakeTarget({ root }),
    journal = new Journal();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  cleanup.push(() => target.dispose());
  const request: OperationRequest = {
    id: "create",
    scope: { orgId: "org", userId: "member", taskId: "task" },
    kind: "create",
    configurationId: "configuration",
  };
  let now = Date.now();
  const open = () => new SandboxOrchestrator({ target, journal, now: () => now });
  return {
    target,
    journal,
    request,
    open,
    advance(ms: number) {
      now += ms;
    },
  };
}
it("claims before provider I/O and coalesces concurrent create without persisting environment", async () => {
  const f = await fixture(),
    original = f.target.create.bind(f.target),
    value = randomBytes(32).toString("base64url");
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const create = vi.spyOn(f.target, "create").mockImplementation(async (spec) => {
    expect(f.journal.inTransaction).toBe(false);
    await barrier;
    return original(spec);
  });
  const prepare = async () => {
    expect(f.journal.inTransaction).toBe(false);
    return { env: { TOKEN: value } };
  };
  const first = f.open().run(f.request, prepare);
  try {
    await expect.poll(() => create.mock.calls.length).toBe(1);
    expect((await f.open().run(f.request, prepare)).state).toBe("pending");
  } finally {
    release();
  }
  expect((await first).state).toBe("done");
  expect((await f.open().run(f.request, prepare)).state).toBe("done");
  expect(create).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...f.journal.rows.values()]).includes(value)).toBe(false);
});
it("recovers a provider create whose reply was lost by labels instead of creating again", async () => {
  const f = await fixture(),
    original = f.target.create.bind(f.target);
  const create = vi.spyOn(f.target, "create").mockImplementation(async (spec) => {
    await original(spec);
    throw new Error("synthetic_reply_lost");
  });
  expect((await f.open().run(f.request, async () => ({}))).state).toBe("pending");
  const recovered = await f.open().run(f.request, async () => ({}));
  expect(recovered.state).toBe("done");
  expect(recovered.refs).toHaveLength(1);
  expect(create).toHaveBeenCalledTimes(1);
});
it.each([
  "before_bound",
  "after_bound",
] as const)("retains resource ownership after %s journal failure", async (failure) => {
  const f = await fixture();
  f.journal.fail = failure;
  const create = vi.spyOn(f.target, "create");
  expect((await f.open().run(f.request, async () => ({}))).state).toBe("pending");
  const recovered = await f.open().run(f.request, async () => ({}));
  expect(recovered.state).toBe("done");
  expect(recovered.refs).toHaveLength(1);
  expect(create).toHaveBeenCalledTimes(1);
});
it("does not retry an uncertain create when provider lookup has no result", async () => {
  const f = await fixture();
  const create = vi
    .spyOn(f.target, "create")
    .mockRejectedValue(new Error("synthetic_transport_loss"));
  for (let i = 0; i < 4; i++)
    expect((await f.open().run(f.request, async () => ({}))).state).toBe("pending");
  expect(create).toHaveBeenCalledTimes(1);
});
it("rejects unknown operation fields before a credential could enter the journal", async () => {
  const f = await fixture(),
    value = randomBytes(32).toString("base64url");
  await expect(
    f.open().run({ ...f.request, env: { TOKEN: value } } as OperationRequest, async () => ({})),
  ).rejects.toThrow(/^sandbox_operation_invalid$/);
  expect(f.journal.rows.size).toBe(0);
});
it("records every ambiguous resource for cleanup instead of selecting one", async () => {
  const f = await fixture(),
    original = f.target.create.bind(f.target);
  vi.spyOn(f.target, "create").mockImplementation(async (spec) => {
    await original(spec);
    await original(spec);
    throw new Error("synthetic_ambiguous_provider");
  });
  await f.open().run(f.request, async () => ({}));
  const result = await f.open().run(f.request, async () => ({}));
  expect(result.state).toBe("ambiguous");
  expect(result.refs).toHaveLength(2);
  expect([...f.journal.rows.values()][0]?.refs).toHaveLength(2);
});
it("retries confirmed lifecycle effects idempotently and rejects changed operation input", async () => {
  const f = await fixture(),
    created = await f.open().run(f.request, async () => ({})),
    ref = created.refs[0];
  if (!ref) throw new Error("fixture_ref_missing");
  await expect(
    f.open().run({ ...f.request, configurationId: "changed" }, async () => ({})),
  ).rejects.toThrow("sandbox_operation_conflict");
  for (const [kind, state] of [
    ["sleep", "sleeping"],
    ["wake", "running"],
    ["destroy", "destroyed"],
  ] as const) {
    const request = { ...f.request, id: kind, kind, ref };
    expect(await f.open().run(request)).toMatchObject({ state: "done", providerState: state });
    expect(await f.open().run(request)).toMatchObject({ state: "done", providerState: state });
  }
});
it("retries failed preparation after its delay without storing the error or starting a provider early", async () => {
  const f = await fixture(),
    value = randomBytes(32).toString("base64url"),
    create = vi.spyOn(f.target, "create");
  let calls = 0;
  const prepare = async () => {
    if (++calls === 1) throw new Error(value);
    return {};
  };
  expect((await f.open().run(f.request, prepare)).state).toBe("pending");
  expect((await f.open().run(f.request, prepare)).state).toBe("pending");
  expect(calls).toBe(1);
  expect(create).not.toHaveBeenCalled();
  f.advance(15000);
  expect((await f.open().run(f.request, prepare)).state).toBe("done");
  expect(JSON.stringify([...f.journal.rows.values()]).includes(value)).toBe(false);
});
it("retries lifecycle failure only after its lease and reconciles a lost destroy reply", async () => {
  const f = await fixture(),
    created = await f.open().run(f.request, async () => ({})),
    ref = created.refs[0];
  if (!ref) throw new Error("fixture_ref_missing");
  const original = f.target.sleep.bind(f.target);
  const sleep = vi
    .spyOn(f.target, "sleep")
    .mockRejectedValueOnce(new Error("synthetic_sleep_failure"))
    .mockImplementation(original);
  const request: OperationRequest = { ...f.request, kind: "sleep", id: "sleep", ref };
  expect((await f.open().run(request)).state).toBe("pending");
  expect((await f.open().run(request)).state).toBe("pending");
  expect(sleep).toHaveBeenCalledTimes(1);
  f.advance(30000);
  expect((await f.open().run(request)).state).toBe("done");
  expect(sleep).toHaveBeenCalledTimes(2);
  const destroyOriginal = f.target.destroy.bind(f.target);
  const destroy = vi.spyOn(f.target, "destroy").mockImplementation(async (value) => {
    await destroyOriginal(value);
    throw new Error("synthetic_reply_lost");
  });
  const deletion: OperationRequest = { ...f.request, kind: "destroy", id: "destroy", ref };
  expect((await f.open().run(deletion)).state).toBe("pending");
  expect(await f.open().run(deletion)).toMatchObject({
    state: "done",
    providerState: "destroyed",
    refs: [ref],
  });
  expect(destroy).toHaveBeenCalledTimes(1);
});
