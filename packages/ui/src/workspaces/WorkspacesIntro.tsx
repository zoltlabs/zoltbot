import { terms } from "@zoltbot/protocol";
import { StatusDot } from "../components/primitives.js";
import type { ChatStatus } from "./activity.js";

type Sample = { name: string; manager: string; chats: [string, ChatStatus][]; teams?: Sample[] };

// A made-up company, drawn with the same marks the sidebar tree uses.
const sample: Sample = {
  name: "acme-app",
  manager: "Project lead",
  chats: [],
  teams: [
    {
      name: "Website launch",
      manager: "Designer",
      chats: [["Copywriter", "needs_you"]],
    },
    {
      name: "Checkout",
      manager: "Developer",
      chats: [
        ["QA", "working"],
        ["Technical writer", "idle"],
      ],
    },
  ],
};

function SampleScope({ scope, root }: { scope: Sample; root?: boolean }) {
  return (
    <li>
      <span className={`wi-scope${root ? " root" : ""}`}>
        {root ? <span className="scope-project-mark h3">{scope.name[0]}</span> : null}
        {scope.name}
      </span>
      <ul>
        <li className="wi-chat">
          <StatusDot status="working" label={false} />
          <span className="grow">{scope.manager}</span>
          <span className="scope-lead">{terms.manager.One}</span>
        </li>
        {scope.chats.map(([title, status]) => (
          <li key={title} className="wi-chat">
            <StatusDot status={status} label={false} />
            <span className="grow">{title}</span>
          </li>
        ))}
        {scope.teams?.map((team) => (
          <SampleScope key={team.name} scope={team} />
        ))}
      </ul>
    </li>
  );
}

/** First-run state for the Workspaces page: what a workspace looks like, and how to make one. */
export function WorkspacesIntro({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate(button: HTMLButtonElement): void;
}) {
  return (
    <div className="workspaces-intro">
      <div className="wi-preview" aria-hidden="true">
        <ul className="wi-tree">
          <SampleScope scope={sample} root />
        </ul>
      </div>
      <div className="wi-copy">
        <h1>Add your first repo</h1>
        <button
          type="button"
          className="btn pri"
          disabled={disabled}
          onClick={(event) => onCreate(event.currentTarget)}
        >
          New {terms.workspace.one}
        </button>
      </div>
    </div>
  );
}
