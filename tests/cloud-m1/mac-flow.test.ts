import { execFileSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createIdentity, linkId, signApproval, toB64 } from "../../packages/link/src/index.js";
import { InteractionSchema, parse } from "../../packages/protocol/src/index.js";
import { dockerAvailable } from "../../packages/sandbox/src/targets/docker/index.js";
import { cellClient, responseJson } from "./client.js";
import { cloudHarness } from "./harness.js";
import { startTestMac } from "./mac.js";

const cases: Array<{ provider: "claude" | "codex"; forged: boolean; target: "fake" | "docker" }> = [
  { provider: "claude", forged: false, target: "fake" },
  { provider: "codex", forged: false, target: "fake" },
  { provider: "claude", forged: true, target: "fake" },
];
if (await dockerAvailable()) cases.push({ provider: "claude", forged: true, target: "docker" });
for (const { provider, forged, target } of cases) {
  it(`${forged ? "refuses a forged signature for" : "relays a phone-signed approval for"} a ${provider} sandbox tool through the real Cell to a headless Mac on ${target}`, async () => {
    const harness = await cloudHarness(provider, { target });
    let mac: Awaited<ReturnType<typeof startTestMac>> | undefined;
    const { client, project, account, proxy, fetch, tls, root } = harness;
    try {
      const task = await harness.task();
      const phone = createIdentity(),
        phoneId = linkId(phone.publicKey);
      const credentials = account.nativeSession({
        userId: "member",
        orgId: "personal",
        deviceId: phoneId,
        surface: "phone",
      });
      const headers = { authorization: `Bearer ${credentials.accessToken}` };
      expect(
        (
          await fetch(new URL("/api/cloud/devices", proxy.origin()), {
            headers,
            body: { deviceId: phoneId, publicKey: toB64(phone.publicKey) },
          })
        ).status,
      ).toBe(200);
      const token = await responseJson(
        await fetch(new URL("/api/cloud/cell-token", proxy.origin()), {
          headers,
          body: { orgId: "personal", deviceId: phoneId },
        }),
      );
      if (typeof token.token !== "string") throw new Error("fixture_phone_token_missing");
      const phoneClient = cellClient({
        origin: proxy.origin(),
        orgId: "personal",
        token: token.token,
        fetch,
      });
      mac = await startTestMac({
        directory: path.join(root, "mac"),
        origin: proxy.origin(),
        orgId: "personal",
        memberId: "member",
        deviceId: harness.deviceId,
        taskId: task.id,
        credentials: harness.session,
        tls,
      });
      await expect
        .poll(() => mac?.statuses().includes("runner_connected"), { timeout: 10000 })
        .toBe(true);
      await expect
        .poll(
          async () => {
            const listed = (await client.rpc("task.list", { projectId: project.id })) as {
              items: Array<{ id: string; state: string }>;
            };
            return listed.items.find((row) => row.id === task.id)?.state;
          },
          { timeout: 30000 },
        )
        .toBe("review");
      await client.rpc(
        "task.review",
        {
          id: task.id,
          revision: 1,
          decision: "changes",
          feedback: "[cloud-m1:mac_exec]",
          confirmed: true,
        },
        "mac-revision",
      );
      let pending: ReturnType<typeof parse<typeof InteractionSchema>> | undefined;
      try {
        await expect
          .poll(
            async () => {
              const listed = (await phoneClient.rpc("interaction.list", {
                projectId: project.id,
              })) as { items: unknown[] };
              pending = listed.items
                .map((value) => parse(InteractionSchema, value))
                .find((row) => row.state === "pending" && row.context?.macExec?.taskId === task.id);
              return !!pending;
            },
            { timeout: 30000 },
          )
          .toBe(true);
      } catch {
        const tasks = (await client.rpc("task.list", { projectId: project.id })) as {
          items: Array<{ state: string; revision: number }>;
        };
        const history = (await client.rpc("thread.history", {
          threadId: task.threadId,
          limit: 200,
        })) as { items: Array<{ kind: string; body?: { text?: string } }> };
        throw new Error(
          JSON.stringify({
            tasks: tasks.items.map((row) => ({ state: row.state, revision: row.revision })),
            messages: history.items
              .filter((row) => row.kind === "message")
              .map((row) => ({
                macro: row.body?.text?.includes("mac_exec") ?? false,
                offline: row.body?.text?.includes("mac_offline") ?? false,
                unavailable: row.body?.text?.includes("mac_unavailable") ?? false,
                ok: row.body?.text === "ok",
              })),
            workers: harness.orchestrator.summaries(),
            mac: mac.statuses(),
          }),
        );
      }
      const interaction = pending;
      if (!interaction?.context?.macExec) throw new Error("fixture_mac_approval_missing");
      const now = Date.now(),
        draft = interaction.context.macExec;
      expect(draft.command).toBe("uname");
      expect(draft.targetDeviceId).toBe(harness.deviceId);
      expect(draft.cwd).toBe(path.join(root, "mac"));
      await phoneClient.rpc(
        "interaction.answer",
        {
          id: interaction.id,
          version: interaction.version,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "member" },
            at: new Date(now).toISOString(),
            signedApproval: signApproval(forged ? createIdentity() : phone, {
              ...draft,
              signerDeviceId: phoneId,
              issuedAt: now,
              expiresAt: now + 300000,
            }),
          },
        },
        "phone-mac-answer",
      );
      if (forged) {
        await expect
          .poll(
            async () => {
              const audit = (await client.rpc("audit.list", { projectId: project.id })) as {
                items: Array<{ action: string; target: string }>;
              };
              return audit.items.some(
                (row) => row.action === "mac.exec.denied" && row.target === task.id,
              );
            },
            { timeout: 10000 },
          )
          .toBe(true);
        const outputExists = await stat(path.join(root, "mac", "runner", "mac-output")).then(
          () => true,
          (error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw new Error("fixture_mac_output_check_failed");
          },
        );
        expect(outputExists).toBe(false);
        expect(harness.cell.refusedNetwork()).toBe(0);
        return;
      }
      const hostUname = execFileSync("/usr/bin/uname", [], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      }).trim();
      let resultText: string | undefined;
      await expect
        .poll(
          async () => {
            const history = (await client.rpc("thread.history", {
              threadId: task.threadId,
              limit: 200,
            })) as { items: Array<{ kind: string; body?: { text?: string } }> };
            resultText = history.items.find(
              (item) => item.kind === "message" && item.body?.text?.includes(hostUname),
            )?.body?.text;
            return !!resultText;
          },
          { timeout: 30000 },
        )
        .toBe(true);
      let envelope: { structuredContent?: { exitCode?: unknown; stdout?: unknown } };
      try {
        envelope = JSON.parse(resultText ?? "");
      } catch {
        throw new Error("fixture_mac_result_invalid");
      }
      expect(envelope.structuredContent?.exitCode).toBe(0);
      expect(envelope.structuredContent?.stdout === `${hostUname}\n`).toBe(true);

      await expect
        .poll(
          async () => {
            const listed = (await client.rpc("task.list", { projectId: project.id })) as {
              items: Array<{ id: string; state: string }>;
            };
            return listed.items.find((row) => row.id === task.id)?.state;
          },
          { timeout: 10000 },
        )
        .toBe("review");
      await client.rpc(
        "task.review",
        {
          id: task.id,
          revision: 2,
          decision: "changes",
          feedback: "[cloud-m1:question]",
          confirmed: true,
        },
        "question-revision",
      );
      let question: ReturnType<typeof parse<typeof InteractionSchema>> | undefined;
      await expect
        .poll(
          async () => {
            const listed = (await phoneClient.rpc("interaction.list", {
              projectId: project.id,
            })) as { items: unknown[] };
            question = listed.items
              .map((row) => parse(InteractionSchema, row))
              .find(
                (row) =>
                  row.state === "pending" && row.type === "question" && row.taskId === task.id,
              );
            return !!question;
          },
          { timeout: 30000 },
        )
        .toBe(true);
      if (!question) throw new Error("fixture_question_missing");
      const answers = Object.fromEntries(
        question.items.map((item) => [
          item.id,
          item.options?.[0]
            ? { options: [item.options[0].id] }
            : { other: "A reply from the phone" },
        ]),
      );
      await phoneClient.rpc(
        "interaction.answer",
        {
          id: question.id,
          version: question.version,
          answer: {
            action: "accept",
            answers,
            by: { kind: "human", id: "member" },
            at: new Date().toISOString(),
          },
        },
        "phone-question-answer",
      );
      await expect
        .poll(
          async () => {
            const listed = (await client.rpc("task.list", { projectId: project.id })) as {
              items: Array<{ id: string; state: string; revision: number }>;
            };
            const row = listed.items.find((row) => row.id === task.id);
            return row?.state === "review" && row.revision === 3;
          },
          { timeout: 30000 },
        )
        .toBe(true);
      expect(harness.cell.refusedNetwork()).toBe(0);
    } finally {
      await mac?.close();
      await harness.close();
    }
  }, 120000);
}
