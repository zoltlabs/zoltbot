import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { serviceToken } from "../../packages/cell/src/service.js";
import { createCloudM1Publication } from "../../tools/fakes/src/cloud-m1-publication.js";
import { harnessRepository } from "./repository.js";

it("refuses a PR until its exact commit exists on the pushed bare branch and replays one publication", async () => {
  const root = await mkdtemp("/private/tmp/zoltbot-m1-publication-");
  try {
    const repository = await harnessRepository(root),
      issuer = "https://accounts.example.invalid",
      key = randomBytes(32).toString("base64url");
    const publication = createCloudM1Publication({
      issuer,
      serviceKey: key,
      orgId: "personal",
      repository: "example/repository",
      base: "main",
      async branchHead(branch) {
        return repository
          .git(root, [
            "--git-dir",
            repository.remote,
            "rev-parse",
            "--verify",
            `refs/heads/${branch}`,
          ])
          .toString()
          .trim();
      },
    });
    const branch = "zoltbot/task-fixture";
    repository.git(repository.source, ["switch", "-c", branch]);
    await writeFile(path.join(repository.source, "README.md"), "Reviewed synthetic change\n");
    repository.git(repository.source, ["add", "README.md"]);
    repository.git(repository.source, [
      "-c",
      "user.name=Zolt Labs",
      "-c",
      "user.email=zolt@zoltbot.ai",
      "commit",
      "-m",
      "Prepare fixture review",
    ]);
    const commit = repository.git(repository.source, ["rev-parse", "HEAD"]).toString().trim();
    const request = {
      path: "/api/cloud/github/pull-request",
      method: "POST",
      operationId: "publish-fixture",
      authorization: `Bearer ${await serviceToken(key, issuer, "orchestrator", "personal")}`,
      body: {
        orgId: "personal",
        repository: "example/repository",
        base: "main",
        head: branch,
        commit,
        title: "Fixture change",
        body: "",
      },
    };
    expect((await publication.handle(request))?.status).toBe(403);
    repository.git(repository.source, ["push", repository.remote, `HEAD:refs/heads/${branch}`]);
    const opened = await publication.handle(request);
    expect(opened?.status).toBe(200);
    expect(await publication.handle(request)).toEqual(opened);
    expect(
      (await publication.handle({ ...request, body: { ...request.body, commit: "0".repeat(40) } }))
        ?.status,
    ).toBe(403);
    expect((await publication.handle({ ...request, authorization: "" }))?.status).toBe(403);
    expect(
      (await publication.handle({ ...request, body: { ...request.body, orgId: "another" } }))
        ?.status,
    ).toBe(403);
    expect(publication.summaries()).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
