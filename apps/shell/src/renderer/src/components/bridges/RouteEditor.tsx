// I1: one route: where messages come from, which chat or channel answers, and who may talk.
import type { BridgePerson, BridgeRoute, BridgeView } from "@zoltbot/protocol";
import { BRIDGE_DIRECT } from "@zoltbot/protocol";
import { createMemo, createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import type { BridgeTargets } from "../../../../shared/bridges";
import { t } from "../../i18n";
import { Field, Select, Stack } from "../../kit";
import { knownPlaces, newId } from "./bridge-model";

const OTHER = "__other";

/** The Select names itself; the visible word lines the rows up like a form. */
function LabeledSelect(props: { label: string; children: JSX.Element }) {
  return (
    <div class="bridge-select-row">
      <span aria-hidden="true">{props.label}</span>
      {props.children}
    </div>
  );
}

export function RouteEditor(props: {
  view: BridgeView;
  route: BridgeRoute | undefined;
  targets: BridgeTargets;
  error: string | null;
  /** Hands the edited route back; the dialog saves it. */
  ref: (read: () => BridgeRoute | null) => void;
}) {
  const places = knownPlaces(props.view);
  const initial = props.route?.from.id ?? BRIDGE_DIRECT;
  const known = initial === BRIDGE_DIRECT || places.some((place) => place.id === initial);
  const [from, setFrom] = createSignal(known ? initial : OTHER);
  const [placeId, setPlaceId] = createSignal(known ? "" : initial);
  const firstTarget = props.targets.chats[0]?.id ?? props.targets.channels[0]?.id ?? "";
  const targetOf = (route: BridgeRoute | undefined) =>
    !route ? firstTarget : route.to.kind === "chat" ? route.to.threadId : route.to.channelId;
  const [to, setTo] = createSignal(targetOf(props.route));
  const [people, setPeople] = createSignal<BridgePerson[]>(props.route?.allow ?? []);
  const [personId, setPersonId] = createSignal("");
  const errorId = createUniqueId();

  const fromOptions = createMemo(() => [
    { value: BRIDGE_DIRECT, label: t("route.direct") },
    ...places.map((place) => ({ value: place.id, label: place.label })),
    { value: OTHER, label: t("route.other") },
  ]);
  const toOptions = createMemo(() => [
    ...props.targets.chats.map((chat) => ({
      value: chat.id,
      label: chat.label,
      group: t("route.chats"),
    })),
    ...props.targets.channels.map((channel) => ({
      value: channel.id,
      label: channel.label,
      group: t("route.channels"),
    })),
  ]);

  const addPerson = () => {
    const id = personId().trim();
    if (!id || people().some((person) => person.id === id)) return setPersonId("");
    setPeople([...people(), { id, name: "" }]);
    setPersonId("");
  };

  props.ref(() => {
    const source = from() === OTHER ? placeId().trim() : from();
    if (!source || !to()) return null;
    const label =
      from() === OTHER
        ? source
        : source === BRIDGE_DIRECT
          ? ""
          : (places.find((place) => place.id === source)?.label ?? source);
    const channel = props.targets.channels.some((option) => option.id === to());
    return {
      id: props.route?.id ?? newId("route"),
      from: { id: source, label },
      to: channel ? { kind: "channel", channelId: to() } : { kind: "chat", threadId: to() },
      allow: people(),
    };
  });

  return (
    <Stack gap={4}>
      <LabeledSelect label={t("route.from")}>
        <Select label={t("route.from")} value={from()} options={fromOptions()} onChange={setFrom} />
      </LabeledSelect>
      <Show when={from() === OTHER}>
        <Field
          label={t("route.placeId")}
          input={(id, describedBy) => (
            <input
              id={id}
              class="zb-kit-input"
              value={placeId()}
              placeholder="C0123ABCD"
              aria-describedby={describedBy}
              onInput={(event) => setPlaceId(event.currentTarget.value)}
            />
          )}
        />
      </Show>
      <LabeledSelect label={t("route.to")}>
        <Select
          label={t("route.to")}
          value={to() || null}
          options={toOptions()}
          onChange={setTo}
          {...(props.error ? { describedBy: errorId } : {})}
        />
      </LabeledSelect>
      <Show when={props.error}>
        <p id={errorId} class="zb-kit-error" role="alert">
          {props.error}
        </p>
      </Show>
      <fieldset class="bridge-people">
        <legend>{t("route.who")}</legend>
        <Show when={people().length} fallback={<p class="bridge-muted">{t("route.nobody")}</p>}>
          <ul class="bridge-chips">
            <For each={people()}>
              {(person) => (
                <li class="bridge-chip">
                  <span>{person.name || person.id}</span>
                  <button
                    type="button"
                    class="bridge-chip-remove"
                    aria-label={t("route.removePerson", { name: person.name || person.id })}
                    onClick={() => setPeople(people().filter((row) => row.id !== person.id))}
                  >
                    <svg aria-hidden="true" viewBox="0 0 12 12">
                      <path d="M3 3l6 6M9 3l-6 6" />
                    </svg>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="bridge-add-person">
          <Field
            label={t("route.personId")}
            input={(id, describedBy) => (
              <input
                id={id}
                class="zb-kit-input"
                value={personId()}
                aria-describedby={describedBy}
                onInput={(event) => setPersonId(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addPerson();
                  }
                }}
              />
            )}
          />
          <button
            type="button"
            class="zb-kit-button"
            disabled={!personId().trim()}
            onClick={addPerson}
          >
            {t("route.add")}
          </button>
        </div>
      </fieldset>
    </Stack>
  );
}
