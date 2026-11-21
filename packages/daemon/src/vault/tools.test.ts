import { handle } from "@zoltbot/core";
import type { Interaction, InteractionAnswer } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";
import { expect, it } from "vitest";
import { memoryKeychain } from "../../../../tools/fakes/src/memory-keychain.js";
import { at, runtimeFixture } from "../../../../tools/fakes/src/runtime-fixture.js";
import type { RuntimeContext } from "../api-types.js";
import { Redactor } from "../logging.js";
import { PrivateInputGuard } from "../private-input.js";
import { vaultApi } from "./api.js";
import type { PageDriver } from "./page-driver.js";
import { respondVaultApproval, vaultTools } from "./tools.js";

const PASSWORD = "synthetic-vault-password-7731";
const actor = { agentId: "profile", threadId: "thread", sessionId: "session", turnId: "turn" };

/** A page with a login form; `fields` maps a ref to its type and the address of its frame. */
function fakePage(fields: Record<string, { type: string; url: string }>) {
  const typed: { target: string; value: string }[] = [];
  let submitted = 0;
  const page: PageDriver = {
    async field(target) {
      const field = fields[target];
      if (!field) throw new Error("browser_unavailable");
      return field;
    },
    async fill(list, origin, submit) {
      for (const { target, types } of list) {
        const field = fields[target];
        if (!field || new URL(field.url).origin !== origin || !types.includes(field.type))
          throw new Error("page_changed");
      }
      for (const { target, value } of list) typed.push({ target, value });
      if (submit) submitted++;
    },
  };
  return { page, typed, submitted: () => submitted };
}

async function setup(fields: Record<string, { type: string; url: string }>) {
  const f = await runtimeFixture();
  const keychain = memoryKeychain();
  const woken: string[] = [];
  const privacy = new PrivateInputGuard({ store: f.store, publish() {} });
  const vault = vaultApi({
    dataDir: f.root,
    store: f.store,
    secrets: keychain.secrets,
    privacy,
    redactor: new Redactor(),
    publish() {},
  });
  const context: RuntimeContext = {
    store: f.store,
    privacy,
    publish() {},
    async wake(id) {
      woken.push(id);
    },
    vault: vault.runtime,
  };
  const page = fakePage(fields);
  const tools = vaultTools(context, { page: () => page.page });
  const call = (args: Record<string, unknown>) =>
    tools.call({ actor, arguments: args, idempotencyKey: "k" }) as Promise<Record<string, unknown>>;
  return { f, vault, context, page, call, woken, keychain };
}

const loginForm = {
  e1: { type: "email", url: "https://github.com/login" },
  e2: { type: "password", url: "https://github.com/login" },
  e3: { type: "text", url: "https://github.com/login" },
  e4: { type: "password", url: "https://evil.example/frame" },
};

async function save(vault: ReturnType<typeof vaultApi>, agents: unknown = "all") {
  const { entry } = (await vault.api("vault.save", {
    kind: "login",
    sites: ["github.com"],
    username: "octo-sample",
    agents,
    value: PASSWORD,
  })) as { entry: { id: string } };
  return entry.id;
}

function cards(store: Store): Interaction[] {
  return (store.snapshot(["interaction"]).interaction ?? [])
    .filter((row) => row.type === "approval")
    .sort((a, b) => String(a.id).localeCompare(String(b.id))) as unknown as Interaction[];
}

function card(store: Store): Interaction {
  const row = cards(store)[0];
  if (!row) throw new Error("no_card");
  return row;
}

function answer(store: Store, request: Interaction, choice: string): InteractionAnswer {
  const value: InteractionAnswer = {
    action: choice === "reject_once" ? "decline" : "accept",
    ...(choice === "reject_once" ? {} : { choice }),
    by: { kind: "human", id: "local-owner" },
    at,
  } as InteractionAnswer;
  store.dispatch(`answer:${request.id}`, (state) =>
    handle(
      state,
      { type: "answer", id: request.id, version: request.version, answer: value },
      { commandId: `answer:${request.id}`, at, actor: value.by },
    ),
  );
  return value;
}

it("types a saved login after the owner allows it, and never returns or stores the value", async () => {
  const { f, vault, context, page, call, woken } = await setup(loginForm);
  try {
    const id = await save(vault);
    expect(await call({ action: "list" })).toEqual({
      logins: [{ id, label: "github.com", sites: ["github.com"], hasUsername: true }],
    });
    expect(await call({ action: "fill", id, password: "e2", username: "e1" })).toEqual({
      status: "waiting_for_owner",
    });
    // Asking again while the card is open doesn't raise a second one.
    expect(await call({ action: "fill", id, password: "e2" })).toEqual({
      status: "waiting_for_owner",
    });
    const request = card(f.store);
    expect(request.title).toBe("Sign in to github.com");
    expect(page.typed).toEqual([]);

    await respondVaultApproval(context, request, answer(f.store, request, "allow_once"));
    expect(woken).toEqual(["thread"]);
    const result = await call({ action: "fill", id, password: "e2", username: "e1", submit: true });
    expect(result).toEqual({ filled: ["username", "password"], submitted: true });
    expect(page.typed).toEqual([
      { target: "e1", value: "octo-sample" },
      { target: "e2", value: PASSWORD },
    ]);
    expect(page.submitted()).toBe(1);
    expect(vault.records.get(id)?.lastUsedAt).toBeTruthy();
    const audit = f.store.snapshot(["audit"]).audit ?? [];
    expect(audit.some((row) => row.action === "vault.fill" && row.target === id)).toBe(true);
    expect(JSON.stringify(f.store.snapshot())).not.toContain(PASSWORD);
  } finally {
    f.close();
  }
});

it("refuses other sites, frames from other sites and fields that aren't passwords", async () => {
  const { f, vault, page, call } = await setup(loginForm);
  try {
    const id = await save(vault);
    expect(await call({ action: "fill", id, password: "e3" })).toEqual({
      error: "not_a_password_field",
    });
    expect(await call({ action: "fill", id, password: "e4" })).toMatchObject({
      error: "site_mismatch",
    });
    expect(await call({ action: "fill", id, password: "e2", username: "e2" })).toEqual({
      error: "not_a_username_field",
    });
    expect(await call({ action: "fill", id, password: "--help" })).toEqual({
      error: "invalid_target",
    });
    expect(page.typed).toEqual([]);
    expect(f.store.snapshot(["interaction"]).interaction ?? []).toEqual([]);
  } finally {
    f.close();
  }
});

it("hides logins from agents that aren't on the list", async () => {
  const { f, vault, page, call } = await setup(loginForm);
  try {
    const other = await save(vault, ["someone-else"]);
    expect(await call({ action: "list" })).toEqual({ logins: [] });
    expect(await call({ action: "fill", id: other, password: "e2" })).toEqual({
      error: "vault_entry_not_found",
    });
    expect(page.typed).toEqual([]);
  } finally {
    f.close();
  }
});

it("Allow once covers one fill; Allow for this chat covers the rest of the run", async () => {
  const { f, vault, context, page, call } = await setup(loginForm);
  try {
    const id = await save(vault);
    await call({ action: "fill", id, password: "e2" });
    let request = cards(f.store)[0] as Interaction;
    await respondVaultApproval(context, request, answer(f.store, request, "allow_once"));
    expect(await call({ action: "fill", id, password: "e2" })).toMatchObject({
      filled: ["password"],
    });
    // The second fill needs a new card.
    expect(await call({ action: "fill", id, password: "e2" })).toEqual({
      status: "waiting_for_owner",
    });
    expect(cards(f.store)).toHaveLength(2);
    request = cards(f.store)[1] as Interaction;
    await respondVaultApproval(context, request, answer(f.store, request, "allow_session"));
    for (let i = 0; i < 3; i++)
      expect(await call({ action: "fill", id, password: "e2" })).toMatchObject({
        filled: ["password"],
      });
    expect(cards(f.store)).toHaveLength(2);
    expect(page.typed).toHaveLength(4);
  } finally {
    f.close();
  }
});

it("stops after the owner declines", async () => {
  const { f, vault, context, page, call } = await setup(loginForm);
  try {
    const id = await save(vault);
    await call({ action: "fill", id, password: "e2" });
    const request = card(f.store);
    await respondVaultApproval(context, request, answer(f.store, request, "reject_once"));
    expect(await call({ action: "fill", id, password: "e2" })).toEqual({ error: "owner_declined" });
    expect(page.typed).toEqual([]);
  } finally {
    f.close();
  }
});

it("says the vault isn't set up when there is no keychain", async () => {
  const f = await runtimeFixture();
  try {
    const tools = vaultTools({
      store: f.store,
      privacy: new PrivateInputGuard({ store: f.store, publish() {} }),
      publish() {},
      async wake() {},
    });
    expect(await tools.call({ actor, arguments: { action: "list" }, idempotencyKey: "k" })).toEqual(
      {
        error: "vault_not_set_up",
      },
    );
  } finally {
    f.close();
  }
});

it("types nothing when the page changed between the check and the fill", async () => {
  const fields = { ...loginForm };
  const { f, vault, context, page, call } = await setup(fields);
  try {
    const id = await save(vault);
    await call({ action: "fill", id, password: "e2" });
    const request = card(f.store);
    await respondVaultApproval(context, request, answer(f.store, request, "allow_session"));
    const fill = page.page.fill;
    page.page.fill = async (list, origin, submit) => {
      fields.e2 = { type: "password", url: "https://evil.example/login" };
      return fill(list, origin, submit);
    };
    expect(await call({ action: "fill", id, password: "e2" })).toEqual({ error: "page_changed" });
    expect(page.typed).toEqual([]);
  } finally {
    f.close();
  }
});

it("refuses plain http and asks again when the login is used on another of its sites", async () => {
  const fields = {
    ...loginForm,
    e5: { type: "password", url: "http://github.com/login" },
    e6: { type: "password", url: "https://www.github.com/login" },
  };
  const { f, vault, context, call } = await setup(fields);
  try {
    const id = await save(vault);
    expect(await call({ action: "fill", id, password: "e5" })).toMatchObject({
      error: "site_mismatch",
    });
    await call({ action: "fill", id, password: "e2" });
    const request = card(f.store);
    await respondVaultApproval(context, request, answer(f.store, request, "allow_session"));
    expect(await call({ action: "fill", id, password: "e6" })).toEqual({
      status: "waiting_for_owner",
    });
    expect(cards(f.store).map((row) => row.title)).toEqual([
      "Sign in to github.com",
      "Sign in to www.github.com",
    ]);
  } finally {
    f.close();
  }
});
