import "../packages/ui/src/tasks/tasks.css";
import { createRoot } from "react-dom/client";
import type { ChatConnection } from "../packages/ui/src/chat/types.js";
import { TaskChangesSection } from "../packages/ui/src/tasks/TaskChangesSection.js";
export function mountWorktreeGallery(theme: string, fail: boolean) {
  document.documentElement.dataset.theme = theme;
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  root.style.padding = "32px";
  root.className = "zb tasks-page";
  const connection: ChatConnection = {
    status: "online",
    snapshot: { seq: 0, entities: {}, counters: {} },
    async call(method) {
      if (fail) throw new Error("destination_dirty");
      if (method === "task.changes")
        return {
          base: "a".repeat(40),
          head: "b".repeat(40),
          status: " M file.ts",
          files: [
            { path: "file.ts", added: 1, removed: 1, patch: "@@ -1 +1 @@\n-old value\n+new value" },
          ],
          uncommittedFiles: [],
        };
      if (method === "task.reviewCommitPreview")
        return {
          fingerprint: "preview",
          head: "b".repeat(40),
          files: [{ path: "file.ts" }, { path: ".env", excluded: "Potential secret" }],
        };
      if (method === "task.integrationPreview")
        return {
          fingerprint: "preview",
          sourceCommit: "b".repeat(40),
          destinationHead: "a".repeat(40),
          destination: "/temporary/repository",
          branch: "refs/heads/main",
          paths: ["file.ts"],
        };
      return { pendingApproval: "approval" };
    },
  };
  createRoot(root).render(
    <>
      <h1>Task review</h1>
      <h2>Done</h2>
      <h3>Example task</h3>
      <TaskChangesSection
        task={{ id: "task", state: "completed", workspaceMode: "worktree" }}
        connection={connection}
      />
    </>,
  );
}
