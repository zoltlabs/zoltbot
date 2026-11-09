import { useMutation } from "@tanstack/react-query";
import { methodCatalog, parse, terms } from "@zoltbot/protocol";
import { useId, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import type { ScopeOption } from "./CreateRule.js";
import { ruleError } from "./rule-data.js";

type Result = {
  decision: "allow" | "deny" | "ask";
  ruleId?: string;
  reason: string;
  destructive: boolean;
};
export default function RulePreview({
  connection,
  profiles,
  projects,
  tools,
  stamp,
}: {
  connection: ChatConnection;
  profiles: ScopeOption[];
  projects: ScopeOption[];
  tools: string[];
  stamp: string;
}) {
  const id = useId();
  const [command, setCommand] = useState(""),
    [tool, setTool] = useState("execute");
  const [agentId, setAgent] = useState(""),
    [projectId, setProject] = useState("");
  const [tested, setTested] = useState<{ key: string; result: Result }>();
  const key = JSON.stringify([command, tool, agentId, projectId, stamp]);
  const preview = useMutation({
    mutationFn: async (input: {
      key: string;
      command: string;
      tool: string;
      agentId: string;
      projectId: string;
    }) =>
      parse(
        methodCatalog["rule.test"].result,
        await connection.call("rule.test", {
          command: input.command,
          tool: input.tool,
          ...(input.agentId ? { agentId: input.agentId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        }),
      ),
    onSuccess: (result, input) => setTested({ key: input.key, result }),
    retry: false,
  });
  const current =
    tested?.key === key && !preview.isPending && !preview.isError ? tested.result : undefined;
  return (
    <section className="card rules-preview" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Check a command</h2>
      <p className="dim">Preview which saved approval rule applies.</p>
      <form
        aria-label="Command rule preview"
        onSubmit={(event) => {
          event.preventDefault();
          if (command.trim()) preview.mutate({ key, command, tool, agentId, projectId });
        }}
      >
        <div className="rules-form-grid">
          <label htmlFor={`${id}-command`} className="rules-wide">
            Command to check
            <input
              id={`${id}-command`}
              value={command}
              maxLength={16000}
              placeholder="Type a command, for example git status"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setCommand(event.target.value)}
            />
          </label>
          <div className="rules-field">
            <label htmlFor={`${id}-tool`}>Preview tool</label>
            <select
              id={`${id}-tool`}
              value={tool}
              onChange={(event) => setTool(event.target.value)}
            >
              {tools.map((value) => (
                <option key={value} value={value}>
                  {value === "execute" ? "Command tools" : value}
                </option>
              ))}
            </select>
          </div>
          <div className="rules-field">
            <label htmlFor={`${id}-profile`}>Preview profile</label>
            <select
              id={`${id}-profile`}
              value={agentId}
              onChange={(event) => setAgent(event.target.value)}
            >
              <option value="">Global rules only</option>
              {profiles.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="rules-field">
            <label htmlFor={`${id}-project`}>Preview {terms.workspace.one}</label>
            <select
              id={`${id}-project`}
              value={projectId}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">No {terms.workspace.one}</option>
              {projects.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="rules-actions">
          <button
            className="btn"
            type="submit"
            disabled={!command.trim() || preview.isPending || connection.status !== "online"}
          >
            {preview.isPending ? "Checking command…" : "Check command"}
          </button>
        </div>
      </form>
      {preview.isError && preview.variables?.key === key ? (
        <p className="rules-error" role="alert">
          {ruleError(preview.error)}
        </p>
      ) : null}
      {current ? (
        <output className={`rules-result ${current.decision}`}>
          <strong>
            {current.decision === "allow"
              ? "Saved rule allows this command."
              : current.decision === "deny"
                ? "Saved rule denies this command."
                : "Ask for approval."}
          </strong>
          {current.reason === "no_rule" ? (
            <span>No saved rule matches this command.</span>
          ) : current.reason === "unsupported_command" ? (
            <span>This command needs individual review.</span>
          ) : null}
        </output>
      ) : null}
    </section>
  );
}
