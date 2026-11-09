import { createRoot } from "react-dom/client";
import { ChangesWorkspace } from "../../packages/ui/src/tasks/ChangesWorkspace.js";
import "../../packages/ui/src/tasks/changes.css";
import "../../packages/ui/src/shell/shell.css";
const file = (path: string, patch: string) => ({ path, patch, added: 1, removed: 1 });
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <main
      className="zb task-changes"
      style={{ padding: "var(--zb-space-4)", display: "block", boxSizing: "border-box" }}
    >
      <ChangesWorkspace
        changes={{
          base: "base-revision",
          head: "head-revision",
          provenance:
            "Task base to working tree; not turn attribution. Untracked files are listed in status only.",
          status: "?? untracked.txt",
          files: [
            file("src/main.ts", "@@ -1 +1 @@\n-old\n+new\n"),
            {
              ...file("image.bin", ""),
              binary: true,
              unavailable: "Binary content is not displayed.",
            },
            file(
              "large.ts",
              `@@ -1,900 +1,900 @@\n${Array.from({ length: 900 }, (_, i) => ` line ${i}`).join("\n")}`,
            ),
          ],
          uncommittedFiles: [file("src/local.ts", "@@ -1 +1 @@\n-before\n+after\n")],
        }}
      />
    </main>,
  );
