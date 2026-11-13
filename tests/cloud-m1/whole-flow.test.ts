import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { createIdentity, linkId, signApproval, toB64 } from "../../packages/link/src/index.js";
import { InteractionSchema, parse } from "../../packages/protocol/src/index.js";
import { cellClient, responseJson } from "./client.js";
import { cloudHarness } from "./harness.js";
import { startTestMac } from "./mac.js";
import { cellStorageCounts } from "./storage.js";

for (const provider of ["claude", "codex"] as const) {
  it(`runs three ${provider} cloud tasks, phone answers, signed Mac execution, replay, review publication, quota and deletion with fakes`, async () => {
    const date = new Date();
    date.setUTCDate(15);
    date.setUTCHours(12, 0, 0, 0);
    let meter = date.getTime(),
      unacknowledgedTask: string | undefined,
      dropAcknowledgements = true,
      dropped = 0;
    const deliveries = new Map<number, number>();
    let duplicated = false;
    const harness = await cloudHarness(provider, {
      now: () => meter,
      limitSeconds: 600,
      transformFrame(frame) {
        let value: { method?: string; params?: { taskId?: string; runnerSeq?: number } };
        try {
          value = JSON.parse(frame.data);
        } catch {
          return frame.data;
        }
        if (value.params && unacknowledgedTask && value.params.taskId === unacknowledgedTask) {
          if (
            frame.direction === "from-cell" &&
            value.method === "runner.ack" &&
            dropAcknowledgements &&
            (value.params.runnerSeq ?? 0) > 0
          ) {
            dropped++;
            return undefined;
          }
          if (
            frame.direction === "to-cell" &&
            value.method === "runner.event" &&
            typeof value.params.runnerSeq === "number"
          ) {
            const copies = !duplicated ? 2 : 1;
            deliveries.set(
              value.params.runnerSeq,
              (deliveries.get(value.params.runnerSeq) ?? 0) + copies,
            );
            if (!duplicated) {
              duplicated = true;
              return [frame.data, frame.data];
            }
          }
        }
        return frame.data;
      },
    });
    const { client, project, account, fetch, proxy, root, tls } = harness;
    let mac: Awaited<ReturnType<typeof startTestMac>> | undefined;
    const tasks = async () =>
      (await client.rpc("task.list", { projectId: project.id })) as {
        items: Array<{ id: string; state: string; revision: number; holdReason?: string }>;
      };
    const waitReview = async (id: string, revision = 1) =>
      expect
        .poll(
          async () => {
            const row = (await tasks()).items.find((row) => row.id === id);
            return row?.state === "review" && row.revision === revision;
          },
          { timeout: 30000 },
        )
        .toBe(true);
    const history = async (threadId: string) =>
      (await client.rpc("thread.history", { threadId, limit: 200 })) as {
        items: Array<{ id: string; kind: string; body?: { text?: string } }>;
      };
    try {
      const first = await harness.task("[cloud-m1:edit]", "first-task"),
        second = await harness.task("[cloud-m1:hang]", "second-task");
      unacknowledgedTask = second.id;
      const third = await harness.task("[cloud-m1:question]", "third-task");
      expect(new Set([first.id, second.id, third.id]).size).toBe(3);
      const phone = createIdentity(),
        phoneId = linkId(phone.publicKey),
        credentials = account.nativeSession({
          userId: "member",
          orgId: "personal",
          deviceId: phoneId,
          surface: "phone",
        }),
        headers = { authorization: `Bearer ${credentials.accessToken}` };
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
      const pending = async (taskId: string, kind: "question" | "approval") => {
        let found: ReturnType<typeof parse<typeof InteractionSchema>> | undefined;
        await expect
          .poll(
            async () => {
              const listed = (await phoneClient.rpc("interaction.list", {
                projectId: project.id,
              })) as { items: unknown[] };
              found = listed.items
                .map((row) => parse(InteractionSchema, row))
                .find(
                  (row) => row.taskId === taskId && row.type === kind && row.state === "pending",
                );
              return !!found;
            },
            { timeout: 30000 },
          )
          .toBe(true);
        if (!found) throw new Error("fixture_interaction_missing");
        return found;
      };
      const question = await pending(third.id, "question");
      await phoneClient.rpc(
        "interaction.answer",
        {
          id: question.id,
          version: question.version,
          answer: {
            action: "accept",
            answers: Object.fromEntries(
              question.items.map((item) => [
                item.id,
                item.options?.[0] ? { options: [item.options[0].id] } : { other: "A phone reply" },
              ]),
            ),
            by: { kind: "human", id: "member" },
            at: new Date().toISOString(),
          },
        },
        "third-phone-answer",
      );
      await waitReview(third.id);
      await waitReview(first.id);
      mac = await startTestMac({
        directory: path.join(root, "mac"),
        origin: proxy.origin(),
        orgId: "personal",
        memberId: "member",
        deviceId: harness.deviceId,
        taskId: first.id,
        credentials: harness.session,
        tls,
      });
      await expect
        .poll(() => mac?.statuses().includes("runner_connected"), { timeout: 10000 })
        .toBe(true);
      await client.rpc(
        "task.review",
        {
          id: first.id,
          revision: 1,
          decision: "changes",
          feedback: "[cloud-m1:mac_exec]",
          confirmed: true,
        },
        "first-request-changes",
      );
      const approval = await pending(first.id, "approval"),
        draft = approval.context?.macExec,
        now = Date.now();
      if (!draft) throw new Error("fixture_mac_draft_missing");
      expect(draft.command).toBe("uname");
      expect(draft.targetDeviceId).toBe(harness.deviceId);
      await phoneClient.rpc(
        "interaction.answer",
        {
          id: approval.id,
          version: approval.version,
          answer: {
            action: "accept",
            choice: "allow_once",
            by: { kind: "human", id: "member" },
            at: new Date(now).toISOString(),
            signedApproval: signApproval(phone, {
              ...draft,
              signerDeviceId: phoneId,
              issuedAt: now,
              expiresAt: now + 300000,
            }),
          },
        },
        "first-mac-answer",
      );
      await waitReview(first.id, 2);
      const uname = execFileSync("/usr/bin/uname", [], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      });
      const message = (await history(first.threadId)).items.find(
        (row) => row.kind === "message" && row.body?.text?.includes(uname.trim()),
      )?.body?.text;
      let output: { structuredContent?: { stdout?: unknown; exitCode?: unknown } };
      try {
        output = JSON.parse(message ?? "");
      } catch {
        throw new Error("fixture_mac_result_invalid");
      }
      expect(output.structuredContent?.stdout === uname).toBe(true);
      expect(output.structuredContent?.exitCode).toBe(0);

      await expect.poll(() => dropped, { timeout: 10000 }).toBeGreaterThan(0);
      await expect
        .poll(async () => (await tasks()).items.find((row) => row.id === second.id)?.state, {
          timeout: 10000,
        })
        .toBe("running");
      await harness.orchestrator.crash("personal", second.id);
      dropAcknowledgements = false;
      await harness.orchestrator.restart("personal", second.id);
      try {
        await waitReview(second.id);
      } catch {
        throw new Error(
          JSON.stringify({
            workers: harness.orchestrator.summaries(),
            tasks: (await tasks()).items.map((row) => ({
              id: row.id,
              state: row.state,
              revision: row.revision,
            })),
            dropped,
            replayed: [...deliveries.values()].filter((count) => count > 1).length,
          }),
        );
      }
      expect([...deliveries.values()].some((count) => count > 1)).toBe(true);
      const replayed = (await history(second.threadId)).items;
      expect(new Set(replayed.map((row) => row.id)).size).toBe(replayed.length);
      expect(
        replayed.filter((row) => row.kind === "message" && row.body?.text === "ok"),
      ).toHaveLength(1);

      let preview: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            preview = (await client.rpc(
              "task.reviewCommitPreview",
              { id: first.id },
              "first-commit-preview",
            )) as Record<string, unknown>;
            return typeof preview.fingerprint === "string";
          },
          { timeout: 20000 },
        )
        .toBe(true);
      expect(Array.isArray(preview.files) && preview.files.length > 0).toBe(true);
      let committed: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            committed = (await client.rpc(
              "task.reviewCommit",
              { id: first.id, fingerprint: preview.fingerprint, confirmed: true },
              "first-review-commit",
            )) as Record<string, unknown>;
            return typeof committed.head === "string";
          },
          { timeout: 20000 },
        )
        .toBe(true);
      let diff: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            diff = (await client.rpc(
              "task.changes",
              { id: first.id },
              "first-clean-diff",
            )) as Record<string, unknown>;
            return diff.head === committed.head;
          },
          { timeout: 20000 },
        )
        .toBe(true);
      expect(diff.status).toBe("");
      await client.rpc(
        "task.review",
        {
          id: first.id,
          revision: 2,
          decision: "accept",
          reviewedCommit: committed.head,
          confirmed: true,
        },
        "first-accept",
      );
      let shipping: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            shipping = (await client.rpc("shipping.get", { id: first.id })) as Record<
              string,
              unknown
            >;
            return shipping.state === "complete";
          },
          { timeout: 20000 },
        )
        .toBe(true);
      expect(harness.publication.summaries()).toHaveLength(1);
      expect(harness.publication.summaries()[0]?.commit).toBe(committed.head);
      const orgLabels = {
        "zoltbot.org": createHash("sha256").update(JSON.stringify("personal")).digest("hex"),
      };
      expect(await harness.target.find(orgLabels)).toHaveLength(3);
      meter += 300000;
      const usage = (await client.rpc("usage.get", {})) as {
        sandboxSeconds: number;
        limitSeconds: number;
        tasks: unknown[];
      };
      expect(usage.sandboxSeconds).toBeGreaterThanOrEqual(900);
      expect(usage.limitSeconds).toBe(600);
      expect(usage.tasks).toHaveLength(3);
      const fourth = await harness.task("A refused fourth task", "fourth-task");
      await expect
        .poll(async () => (await tasks()).items.find((row) => row.id === fourth.id)?.holdReason, {
          timeout: 10000,
        })
        .toBe("limit_reached");
      expect(await harness.target.find(orgLabels)).toHaveLength(3);
      const storageBefore = await cellStorageCounts(path.join(root, "cell"));
      expect(storageBefore.projects).toBe(1);
      expect(storageBefore.events).toBeGreaterThan(0);
      expect(
        (
          await fetch(new URL("/api/account", proxy.origin()), {
            method: "DELETE",
            headers: { authorization: `Bearer ${harness.session.accessToken}` },
            body: { confirm: "DELETE" },
          })
        ).status,
      ).toBe(202);
      expect(await account.drainDeletions()).toBe(1);
      expect(await harness.target.find(orgLabels)).toEqual([]);
      expect(account.stateFor("member")).toEqual({
        sessions: 0,
        devices: 0,
        grants: 0,
        secrets: 0,
        deletionPending: false,
        deleted: true,
      });
      expect(harness.cell.refusedNetwork()).toBe(0);
      await expect(client.rpc("cloud.project.list", {})).rejects.toThrow("fixture_rpc_http_401");
      await harness.cell.close();
      expect(await cellStorageCounts(path.join(root, "cell"))).toEqual({
        events: 0,
        projects: 0,
        cell_identity: 0,
      });
    } finally {
      await mac?.close();
      await harness.close();
    }
  }, 180000);
}
