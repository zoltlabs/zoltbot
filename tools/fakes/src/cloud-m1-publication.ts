import { createHash } from "node:crypto";
import { verifyServiceToken } from "../../../packages/cell/src/service.js";
import type { FakeAccountRequest } from "./cloud-m1-account.js";

interface Publication {
  fingerprint: string;
  commit: string;
  head: string;
  result: { number: number; url: string };
}
/** Fake GitHub opens a PR only after the real worker pushed its accepted head to the bare remote. */
export function createCloudM1Publication(options: {
  issuer: string;
  serviceKey: string;
  orgId: string;
  repository: string;
  base: string;
  branchHead(branch: string): Promise<string>;
}) {
  const publications = new Map<string, Publication>();
  return Object.freeze({
    async handle(request: FakeAccountRequest) {
      if (request.path !== "/api/cloud/github/pull-request") return undefined;
      try {
        const input = request.body as Record<string, unknown>;
        if (
          !input ||
          request.method !== "POST" ||
          !request.operationId ||
          Object.keys(input).sort().join(",") !== "base,body,commit,head,orgId,repository,title" ||
          input.orgId !== options.orgId ||
          input.repository !== options.repository ||
          input.base !== options.base ||
          typeof input.head !== "string" ||
          !/^zoltbot\/task-[a-zA-Z0-9_-]{1,64}$/.test(input.head) ||
          typeof input.commit !== "string" ||
          !/^[a-f0-9]{40}$/.test(input.commit) ||
          typeof input.title !== "string" ||
          !input.title ||
          input.title.length > 256 ||
          /[\0\r\n]/.test(input.title) ||
          typeof input.body !== "string" ||
          input.body.length > 60000 ||
          input.body.includes("\0")
        )
          throw new Error();
        const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.authorization ?? "")?.[1] ?? "";
        await verifyServiceToken(
          bearer,
          options.serviceKey,
          options.issuer,
          "orchestrator",
          options.orgId,
        );
        const fingerprint = createHash("sha256")
            .update(
              JSON.stringify([
                input.orgId,
                input.repository,
                input.base,
                input.head,
                input.commit,
                input.title,
                input.body,
              ]),
            )
            .digest("hex"),
          previous = publications.get(request.operationId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new Error();
          return { status: 200, body: structuredClone(previous.result) };
        }
        if ((await options.branchHead(input.head)) !== input.commit) throw new Error();
        const number = publications.size + 1,
          result = { number, url: `https://github.com/${options.repository}/pull/${number}` };
        publications.set(request.operationId, {
          fingerprint,
          commit: input.commit,
          head: input.head,
          result,
        });
        return { status: 200, body: structuredClone(result) };
      } catch {
        return { status: 403, body: { error: "fixture_publication_refused" } };
      }
    },
    summaries: () =>
      [...publications.values()].map((value) => ({
        head: value.head,
        commit: value.commit,
        ...value.result,
      })),
  });
}
