import { createMemo, createSignal, For, Show } from "solid-js";
import type { StaffActionInput, StaffPerson } from "../../../shared/staff";
import { Select } from "../kit";
import { createStaffStore } from "../staff-store";
import { StaffCard } from "./StaffCard";
import "../staff.css";

const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': /, "")
    : "";
const run = (input: StaffActionInput) => window.openbot.agent.staffAction(input);

function roleLabel(person: StaffPerson) {
  if (person.role === "ceo") return "CEO";
  if (person.role === "manager") return person.teamName ? `${person.teamName} manager` : "Manager";
  return person.teamName || "Employee";
}
function status(person: StaffPerson) {
  if (person.archiving) return "Archiving after current work";
  if (person.pending === "archive") return "Archive pending";
  if (person.pending) return "Change pending";
  if (person.allowance && person.allowance.max > person.allowance.used)
    return `May add ${person.allowance.max - person.allowance.used} more`;
  return "";
}

/**
 * The people of a project with Edit and Archive, and the team changes waiting for the owner.
 * Saving and archiving apply at once and roll back with an error if the daemon refuses them.
 */
export function StaffPeople(props: { projectId: string; onOpenChat: (botId: string) => void }) {
  const store = createStaffStore(() => props.projectId);
  const [editing, setEditing] = createSignal<string | null>(null);
  const [archiving, setArchiving] = createSignal<string | null>(null);
  const [overrides, setOverrides] = createSignal<Record<string, Partial<StaffPerson> | null>>({});
  const [error, setError] = createSignal("");
  const people = createMemo(() =>
    store
      .people()
      .filter((person) => overrides()[person.botId] !== null)
      .map((person) => ({ ...person, ...overrides()[person.botId] })),
  );
  const forget = (botId: string) => setOverrides(({ [botId]: _gone, ...rest }) => rest);

  async function save(person: StaffPerson, form: HTMLFormElement) {
    const data = new FormData(form);
    const field = (key: string) => String(data.get(key) ?? "").trim();
    const change: Partial<Record<"name" | "model" | "roleText" | "instructions", string>> = {};
    if (field("name") && field("name") !== person.name) change.name = field("name");
    if (field("model") !== person.model) change.model = field("model");
    if (field("role") !== person.roleText) change.roleText = field("role");
    if (field("instructions") !== person.instructions) change.instructions = field("instructions");
    const max = person.role === "employee" ? null : Number(field("allowance") || 0);
    const allowanceChanged = max !== null && max !== (person.allowance?.max ?? 0);
    setEditing(null);
    setError("");
    if (!Object.keys(change).length && !allowanceChanged) return;
    setOverrides((current) => ({
      ...current,
      [person.botId]: {
        ...change,
        ...(allowanceChanged ? { allowance: max ? { max, used: 0 } : null } : {}),
      },
    }));
    try {
      if (Object.keys(change).length) {
        const { roleText, ...rest } = change;
        await run({
          action: "change",
          threadId: person.botId,
          ...rest,
          ...(roleText !== undefined ? { role: roleText } : {}),
        });
      }
      if (allowanceChanged && max !== null)
        await run({ action: "allowance", threadId: person.botId, max });
      store.refresh();
    } catch (failure) {
      setError(errorText(failure) || `Couldn't save ${person.name}.`);
      setEditing(person.botId);
    } finally {
      forget(person.botId);
    }
  }

  async function archive(person: StaffPerson, moveTo: string) {
    setArchiving(null);
    setError("");
    setOverrides((current) => ({ ...current, [person.botId]: null }));
    try {
      await run({ action: "archive", threadId: person.botId, ...(moveTo ? { moveTo } : {}) });
      store.refresh();
    } catch (failure) {
      setError(errorText(failure) || `Couldn't archive ${person.name}.`);
    } finally {
      forget(person.botId);
    }
  }

  return (
    <>
      <Show when={store.approvals().length > 0}>
        <section class="organization-section" aria-labelledby="staff-approvals-heading">
          <h3 id="staff-approvals-heading">Team changes to review</h3>
          <div class="staff-needs">
            <For each={store.approvals()}>
              {(card) => <StaffCard card={card} onOpenChat={props.onOpenChat} />}
            </For>
          </div>
        </section>
      </Show>
      <Show when={people().length > 0}>
        <section class="organization-section" aria-labelledby="staff-people-heading">
          <h3 id="staff-people-heading">People</h3>
          <Show when={error()}>
            <p class="manager-error" role="alert">
              {error()}
            </p>
          </Show>
          <ul class="organization-list">
            <For each={people()}>
              {(person) => (
                <li>
                  <div class="organization-person">
                    <span class="organization-person-text">
                      <strong>{person.name}</strong>
                      <span>{roleLabel(person)}</span>
                      <Show when={status(person)}>
                        <span>{status(person)}</span>
                      </Show>
                    </span>
                    <span class="staff-person-actions">
                      <button
                        type="button"
                        class="organization-link"
                        aria-label={`Edit ${person.name}`}
                        aria-expanded={editing() === person.botId}
                        onClick={() => {
                          setArchiving(null);
                          setEditing(editing() === person.botId ? null : person.botId);
                        }}
                      >
                        Edit
                      </button>
                      <Show when={person.role !== "ceo" && !person.archiving}>
                        <button
                          type="button"
                          class="organization-link"
                          aria-label={`Archive ${person.name}`}
                          aria-expanded={archiving() === person.botId}
                          onClick={() => {
                            setEditing(null);
                            setArchiving(archiving() === person.botId ? null : person.botId);
                          }}
                        >
                          Archive
                        </button>
                      </Show>
                    </span>
                  </div>
                  <Show when={editing() === person.botId}>
                    <EditForm
                      person={person}
                      onCancel={() => setEditing(null)}
                      onSave={(form) => void save(person, form)}
                    />
                  </Show>
                  <Show when={archiving() === person.botId}>
                    <ArchiveForm
                      person={person}
                      others={people().filter((other) => other.botId !== person.botId)}
                      onCancel={() => setArchiving(null)}
                      onArchive={(moveTo) => void archive(person, moveTo)}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </>
  );
}

function EditForm(props: {
  person: StaffPerson;
  onCancel: () => void;
  onSave: (form: HTMLFormElement) => void;
}) {
  const id = `staff-edit-${props.person.botId.replace(/[^\w-]/g, "-")}`;
  return (
    <form
      class="staff-form"
      aria-label={`Edit ${props.person.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(event.currentTarget);
      }}
      onKeyDown={(event) => event.key === "Escape" && props.onCancel()}
    >
      <label for={`${id}-name`}>
        Name
        <input id={`${id}-name`} name="name" value={props.person.name} maxLength={150} required />
      </label>
      <label for={`${id}-role`}>
        Role
        <input id={`${id}-role`} name="role" value={props.person.roleText} maxLength={300} />
      </label>
      <label for={`${id}-model`}>
        Model
        <input id={`${id}-model`} name="model" value={props.person.model} maxLength={100} />
      </label>
      <label for={`${id}-instructions`}>
        Instructions
        <textarea id={`${id}-instructions`} name="instructions" maxLength={4000}>
          {props.person.instructions}
        </textarea>
      </label>
      <Show when={props.person.role !== "employee"}>
        <label for={`${id}-allowance`}>
          People they may add without asking
          <input
            id={`${id}-allowance`}
            name="allowance"
            type="number"
            min={0}
            max={20}
            step={1}
            value={props.person.allowance?.max ?? 0}
          />
        </label>
      </Show>
      <div class="organization-actions">
        <button type="button" class="organization-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="organization-button organization-button-primary">
          Save
        </button>
      </div>
    </form>
  );
}

function ArchiveForm(props: {
  person: StaffPerson;
  others: StaffPerson[];
  onCancel: () => void;
  onArchive: (moveTo: string) => void;
}) {
  const [moveTo, setMoveTo] = createSignal("");
  return (
    <form
      class="staff-form"
      aria-label={`Archive ${props.person.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        props.onArchive(moveTo());
      }}
      onKeyDown={(event) => {
        // The kit list closes itself on Escape; only close the form when nothing is open.
        if (event.key === "Escape" && !event.defaultPrevented) props.onCancel();
      }}
    >
      <div class="staff-field">
        <span aria-hidden="true">Queued tasks go to</span>
        <Select
          label="Queued tasks go to"
          value={moveTo()}
          options={[
            { value: "", label: "Their manager" },
            ...props.others.map((other) => ({ value: other.botId, label: other.name })),
          ]}
          onChange={setMoveTo}
        />
      </div>
      <p class="staff-card-note">Running work finishes first. Their chat stays readable.</p>
      <div class="organization-actions">
        <button type="button" class="organization-button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" class="organization-button staff-button-danger">
          Archive {props.person.name}
        </button>
      </div>
    </form>
  );
}
