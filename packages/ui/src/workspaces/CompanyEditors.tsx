import type { CompanyChange, InitiativeRecord, ManagerRemit } from "@zoltbot/protocol";
import { useId, useState } from "react";
import { type Row, text } from "../chat/types.js";
export function InitiativeEditor({
  value,
  projectId,
  teams,
  chats,
  disabled,
  onSave,
  onCancel,
}: {
  value: InitiativeRecord | undefined;
  projectId: string;
  teams: Row[];
  chats: Row[];
  disabled: boolean;
  onSave(v: InitiativeRecord): void;
  onCancel(): void;
}) {
  const ids = useId();
  return (
    <form
      className="company-fields"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const at = new Date().toISOString();
        const manager = String(f.get("owner") ?? ""),
          team = String(f.get("team") ?? "");
        onSave({
          id: value?.id ?? crypto.randomUUID(),
          projectId,
          title: String(f.get("title")),
          outcome: String(f.get("outcome")),
          acceptance: String(f.get("acceptance")),
          ...(manager ? { managerThreadId: manager } : {}),
          ...(team ? { teamId: team } : {}),
          priority: String(f.get("priority")) as InitiativeRecord["priority"],
          state: String(f.get("state")) as InitiativeRecord["state"],
          constraints: String(f.get("constraints")),
          knowledgeIds: value?.knowledgeIds ?? [],
          version: (value?.version ?? 0) + 1,
          createdAt: value?.createdAt ?? at,
          updatedAt: at,
          ...(value?.budgetUsd !== undefined ? { budgetUsd: value.budgetUsd } : {}),
          ...(value?.targetDate ? { targetDate: value.targetDate } : {}),
        });
      }}
    >
      <label htmlFor={`${ids}-title`}>
        Initiative title
        <input
          id={`${ids}-title`}
          name="title"
          required
          maxLength={150}
          defaultValue={value?.title}
        />
      </label>
      <label htmlFor={`${ids}-outcome`}>
        Outcome
        <textarea
          id={`${ids}-outcome`}
          name="outcome"
          required
          maxLength={2000}
          defaultValue={value?.outcome}
        />
      </label>
      <label htmlFor={`${ids}-acceptance`}>
        Acceptance criteria
        <textarea
          id={`${ids}-acceptance`}
          name="acceptance"
          maxLength={2000}
          defaultValue={value?.acceptance}
        />
      </label>
      <label htmlFor={`${ids}-owner`}>
        Accountable owner
        <select id={`${ids}-owner`} name="owner" defaultValue={value?.managerThreadId ?? ""}>
          <option value="">No owner yet</option>
          {chats
            .filter((r) => r.kind !== "task")
            .map((r) => (
              <option key={text(r.id)} value={text(r.id)}>
                {text(r.title)}
              </option>
            ))}
        </select>
      </label>
      <label htmlFor={`${ids}-team`}>
        Team
        <select id={`${ids}-team`} name="team" defaultValue={value?.teamId ?? ""}>
          <option value="">Workspace</option>
          {teams.map((r) => (
            <option key={text(r.id)} value={text(r.id)}>
              {text(r.name)}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor={`${ids}-priority`}>
        Priority
        <select id={`${ids}-priority`} name="priority" defaultValue={value?.priority ?? "normal"}>
          {["low", "normal", "high", "urgent"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label htmlFor={`${ids}-state`}>
        Status
        <select id={`${ids}-state`} name="state" defaultValue={value?.state ?? "active"}>
          {["proposed", "active", "paused", "review", "completed", "cancelled"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label htmlFor={`${ids}-constraints`}>
        Constraints
        <textarea
          id={`${ids}-constraints`}
          name="constraints"
          maxLength={2000}
          defaultValue={value?.constraints}
        />
      </label>
      <div className="r wrap">
        <button className="btn" disabled={disabled} type="submit">
          Propose initiative
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel initiative edit
        </button>
      </div>
    </form>
  );
}
export function RemitEditor({
  chat,
  saved,
  projectId,
  disabled,
  onSave,
  onCancel,
}: {
  chat: Row;
  saved: ManagerRemit | undefined;
  projectId: string;
  disabled: boolean;
  onSave(v: ManagerRemit): void;
  onCancel(): void;
}) {
  const ids = useId();
  return (
    <form
      className="company-fields"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        onSave({
          id: text(chat.id),
          threadId: text(chat.id),
          projectId,
          responsibilities: String(f.get("responsibilities")),
          capabilities: String(f.get("capabilities")),
          boundaries: String(f.get("boundaries")),
          escalation: String(f.get("escalation")),
          version: (saved?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
      }}
    >
      {(["responsibilities", "capabilities", "boundaries", "escalation"] as const).map((field) => (
        <label key={field} htmlFor={`${ids}-${field}`}>
          {field === "responsibilities"
            ? "Responsibilities"
            : field === "capabilities"
              ? "Capabilities"
              : field === "boundaries"
                ? "Boundaries"
                : "Escalation rules"}
          <textarea
            id={`${ids}-${field}`}
            name={field}
            maxLength={2000}
            defaultValue={saved?.[field]}
          />
        </label>
      ))}
      <div className="r wrap">
        <button className="btn" type="submit" disabled={disabled}>
          Propose responsibilities
        </button>
        <button className="btn" type="button" onClick={onCancel}>
          Cancel responsibilities edit
        </button>
      </div>
    </form>
  );
}
export function StructureEditor({
  teams,
  chats,
  projectId,
  disabled,
  name,
  onPropose,
}: {
  teams: Row[];
  chats: Row[];
  projectId: string;
  disabled: boolean;
  name(id: unknown): string;
  onPropose(c: CompanyChange[]): void;
}) {
  const ids = useId();
  const [action, setAction] = useState("renameTeam");
  return (
    <details>
      <summary>Propose an organization change</summary>
      <form
        className="company-fields"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const id = String(f.get("target")),
            target = String(f.get("parent")),
            why = String(f.get("why"));
          const parent = {
            type: target === projectId ? ("project" as const) : ("subproject" as const),
            id: target,
          };
          onPropose([
            action === "renameTeam"
              ? { kind: "renameTeam", id, name: String(f.get("name")), why }
              : action === "archiveTeam"
                ? { kind: "archiveTeam", id, why }
                : action === "moveChat"
                  ? { kind: "moveChat", id, parent, why }
                  : { kind: "moveTeam", id, parent, why },
          ]);
        }}
      >
        <label htmlFor={`${ids}-action`}>
          Change
          <select id={`${ids}-action`} value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="renameTeam">Rename team</option>
            <option value="moveTeam">Move team</option>
            <option value="archiveTeam">Archive empty team</option>
            <option value="moveChat">Move chat or manager</option>
          </select>
        </label>
        <label htmlFor={`${ids}-target`}>
          {action === "moveChat" ? "Chat or manager" : "Team"}
          <select id={`${ids}-target`} name="target" required key={action}>
            {(action === "moveChat" ? chats.filter((r) => r.kind !== "task") : teams).map((r) => (
              <option key={text(r.id)} value={text(r.id)}>
                {name(r.id)}
              </option>
            ))}
          </select>
        </label>
        {action === "renameTeam" ? (
          <label htmlFor={`${ids}-name`}>
            New name
            <input id={`${ids}-name`} name="name" required maxLength={150} />
          </label>
        ) : action !== "archiveTeam" ? (
          <label htmlFor={`${ids}-parent`}>
            Destination
            <select id={`${ids}-parent`} name="parent">
              <option value={projectId}>Workspace</option>
              {teams.map((r) => (
                <option key={text(r.id)} value={text(r.id)}>
                  {text(r.name)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label htmlFor={`${ids}-why`}>
          Why this helps
          <textarea id={`${ids}-why`} name="why" required maxLength={2000} />
        </label>
        <button
          className="btn"
          type="submit"
          disabled={disabled || !(action === "moveChat" ? chats.length : teams.length)}
        >
          Preview organization change
        </button>
      </form>
    </details>
  );
}
