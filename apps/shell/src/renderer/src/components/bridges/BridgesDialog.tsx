// I1: Bridges, from the account menu. Lists each chat app bridge with its status, its routes and
// who wrote without being on a list; adds and edits bridges and routes.
import type { BridgeRoute, BridgeView } from "@zoltbot/protocol";
import { BRIDGE_DIRECT } from "@zoltbot/protocol";
import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { t } from "../../i18n";
import { ConfirmDialog, Dialog, EmptyState, Field, Select, Stack } from "../../kit";
import {
  appName,
  newId,
  placeLabel,
  problemText,
  statusLabel,
  toInput,
} from "./bridge-model";
import { RouteEditor } from "./RouteEditor";
import { BRIDGE_SETUPS, type BridgeSetupSpec } from "./setup";
import "./bridges.css";

type Screen =
  | { name: "list" }
  | { name: "pick" }
  | { name: "setup"; spec: BridgeSetupSpec }
  | { name: "bridge"; id: string }
  | { name: "route"; id: string; routeId?: string };

/** While the dialog is open, status changes (Reconnecting, Connected) show without a reload. */
const REFRESH_MS = 2000;

export function BridgesDialog(props: { onClose: () => void }) {
  const api = window.openbot.bridges;
  const [screen, setScreen] = createSignal<Screen>({ name: "list" });
  const [views, { refetch, mutate }] = createResource(() => api.list());
  const [targets] = createResource(() => api.targets());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<BridgeView | null>(null);
  const timer = setInterval(() => {
    if (!busy()) void refetch();
  }, REFRESH_MS);
  onCleanup(() => clearInterval(timer));

  const current = () => {
    const now = screen();
    return "id" in now ? views()?.find((view) => view.bridge.id === now.id) : undefined;
  };
  const go = (next: Screen) => {
    setError(null);
    setScreen(next);
  };

  async function save(view: BridgeView, credentials?: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.save({
        bridge: toInput(view.bridge),
        ...(credentials ? { credentials } : {}),
      });
      mutate((list) => {
        const rest = (list ?? []).filter((row) => row.bridge.id !== saved.bridge.id);
        return [...rest, saved].sort((a, b) =>
          a.bridge.createdAt.localeCompare(b.bridge.createdAt),
        );
      });
      return saved;
    } catch {
      setError(t("bridges.saveFailed"));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const withRoutes = (view: BridgeView, routes: BridgeRoute[]): BridgeView => ({
    ...view,
    bridge: { ...view.bridge, routes },
  });

  async function allow(view: BridgeView, refusalId: string) {
    const entry = view.refused.find((row) => row.id === refusalId);
    const route = view.bridge.routes.find((row) => row.id === entry?.routeId);
    if (!entry || !route) return;
    await save(
      withRoutes(
        view,
        view.bridge.routes.map((row) =>
          row.id === route.id ? { ...row, allow: [...row.allow, entry.person] } : row,
        ),
      ),
    );
  }

  let readRoute: (() => BridgeRoute | null) | undefined;
  async function saveRoute(view: BridgeView, routeId: string | undefined) {
    const route = readRoute?.();
    if (!route) return setError(t("route.incomplete"));
    const routes = routeId
      ? view.bridge.routes.map((row) => (row.id === routeId ? route : row))
      : [...view.bridge.routes, route];
    if (await save(withRoutes(view, routes))) go({ name: "bridge", id: view.bridge.id });
  }

  // Setup: the tokens, then who answers direct messages.
  const [tokens, setTokens] = createSignal<Record<string, string>>({});
  const [answerer, setAnswerer] = createSignal<string | null>(null);
  async function add(spec: BridgeSetupSpec) {
    const to = answerer() ?? targets()?.chats[0]?.id;
    if (!to) return setError(t("route.incomplete"));
    const channel = targets()?.channels.some((row) => row.id === to);
    const now = new Date().toISOString();
    const saved = await save(
      {
        bridge: {
          id: newId("bridge"),
          kind: spec.kind,
          label: appName(spec.kind),
          enabled: true,
          routes: [
            {
              id: newId("route"),
              from: { id: BRIDGE_DIRECT, label: "" },
              to: channel ? { kind: "channel", channelId: to } : { kind: "chat", threadId: to },
              allow: [],
            },
          ],
          ...(spec.options ? { options: spec.options() } : {}),
          createdAt: now,
          updatedAt: now,
        },
        status: { state: "stopped", at: now },
        refused: [],
      },
      tokens(),
    );
    setTokens({});
    if (saved) go({ name: "bridge", id: saved.bridge.id });
  }

  async function remove() {
    const view = removing();
    if (!view) return;
    setBusy(true);
    try {
      await api.remove(view.bridge.id);
      mutate((list) => (list ?? []).filter((row) => row.bridge.id !== view.bridge.id));
      setRemoving(null);
      go({ name: "list" });
    } catch {
      setError(t("bridges.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const title = () => {
    const now = screen();
    if (now.name === "setup") return t("bridges.setup.title", { app: appName(now.spec.kind) });
    if (now.name === "bridge") return current()?.bridge.label ?? t("bridges.title");
    if (now.name === "route") return now.routeId ? t("route.editTitle") : t("route.newTitle");
    return t("bridges.title");
  };

  const button = (label: string, run: () => void, kind = "", disabled = false) => (
    <button
      type="button"
      class={`zb-kit-button ${kind}`}
      disabled={busy() || disabled}
      onClick={run}
    >
      {label}
    </button>
  );

  return (
    <>
      <Dialog
        title={title()}
        width={560}
        busy={busy()}
        onClose={props.onClose}
        actions={
          <Switch>
            <Match when={screen().name === "list"}>
              {button(t("bridges.close"), props.onClose)}
              <Show when={BRIDGE_SETUPS.length && views()?.length}>
                {button(t("bridges.add"), () => go({ name: "pick" }), "primary")}
              </Show>
            </Match>
            <Match when={screen().name === "pick"}>
              {button(t("bridges.back"), () => go({ name: "list" }))}
            </Match>
            <Match when={screen().name === "setup"}>
              {button(t("bridges.cancel"), () => go({ name: "list" }))}
              {button(
                t("bridges.add"),
                () => {
                  const now = screen();
                  if (now.name === "setup") void add(now.spec);
                },
                "primary",
              )}
            </Match>
            <Match when={screen().name === "bridge" && current()}>
              {(view) => (
                <>
                  {button(t("bridges.remove"), () => setRemoving(view()), "danger")}
                  {button(
                    view().bridge.enabled ? t("bridges.stop") : t("bridges.start"),
                    () =>
                      void save({
                        ...view(),
                        bridge: { ...view().bridge, enabled: !view().bridge.enabled },
                      }),
                  )}
                  {button(t("bridges.done"), () => go({ name: "list" }), "primary")}
                </>
              )}
            </Match>
            <Match when={screen().name === "route" && current()}>
              {(view) => {
                const routeId = (screen() as { routeId?: string }).routeId;
                return (
                  <>
                    <Show when={routeId}>
                      {button(
                        t("route.remove"),
                        () =>
                          void save(
                            withRoutes(
                              view(),
                              view().bridge.routes.filter((row) => row.id !== routeId),
                            ),
                          ).then(
                            (saved) => saved && go({ name: "bridge", id: view().bridge.id }),
                          ),
                        "danger",
                      )}
                    </Show>
                    {button(t("bridges.cancel"), () => go({ name: "bridge", id: view().bridge.id }))}
                    {button(t("route.save"), () => void saveRoute(view(), routeId), "primary")}
                  </>
                );
              }}
            </Match>
          </Switch>
        }
      >
        <Switch>
          <Match when={views.loading && !views.latest}>
            <p class="bridge-muted" role="status">
              {t("bridges.loading")}
            </p>
          </Match>
          <Match when={views.error && !views.latest}>
            <p class="zb-kit-error" role="alert">
              {t("bridges.loadFailed")}
            </p>
          </Match>
          <Match when={screen().name === "list"}>
            <Show
              when={views()?.length}
              fallback={
                <EmptyState
                  title={t("bridges.empty")}
                  {...(BRIDGE_SETUPS.length
                    ? {
                        action: button(t("bridges.add"), () => go({ name: "pick" }), "primary"),
                      }
                    : {})}
                />
              }
            >
              <ul class="bridge-list" aria-label={t("bridges.title")}>
                <For each={views()}>
                  {(view) => (
                    <li>
                      <button
                        type="button"
                        class="bridge-row"
                        onClick={() => go({ name: "bridge", id: view.bridge.id })}
                      >
                        <span class="bridge-row-name">
                          <strong>{view.bridge.label}</strong>
                          <span>
                            {[
                              problemText(view.status) ?? view.status.account,
                              t("bridges.routeCount", { count: view.bridge.routes.length }),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <span class={`bridge-status bridge-status-${view.status.state}`}>
                          <span class="bridge-dot" aria-hidden="true" />
                          {statusLabel(view.status)}
                        </span>
                        <svg class="bridge-chevron" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M6 3.5 10.5 8 6 12.5" />
                        </svg>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Match>
          <Match when={screen().name === "pick"}>
            <ul class="bridge-list" aria-label={t("bridges.add")}>
              <For each={BRIDGE_SETUPS}>
                {(spec) => (
                  <li>
                    <button
                      type="button"
                      class="bridge-row"
                      onClick={() => {
                        setTokens({});
                        setAnswerer(null);
                        go({ name: "setup", spec });
                      }}
                    >
                      <span class="bridge-row-name">
                        <strong>{appName(spec.kind)}</strong>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Match>
          <Match when={screen().name === "setup" && (screen() as { spec: BridgeSetupSpec }).spec}>
            {(spec) => (
              <Stack gap={4}>
                <Show when={spec().before}>{(before) => before()()}</Show>
                <For each={spec().fields}>
                  {(field) => (
                    <Field
                      label={t(field.label)}
                      input={(id, describedBy) => (
                        <input
                          id={id}
                          type="password"
                          autocomplete="off"
                          spellcheck={false}
                          class="zb-kit-input"
                          placeholder={field.placeholder}
                          aria-describedby={describedBy}
                          value={tokens()[field.key] ?? ""}
                          onInput={(event) =>
                            setTokens({ ...tokens(), [field.key]: event.currentTarget.value })
                          }
                        />
                      )}
                    />
                  )}
                </For>
                <div class="bridge-select-row">
                  <span aria-hidden="true">{t("bridges.setup.answers")}</span>
                  <Select
                    label={t("bridges.setup.answers")}
                    value={answerer() ?? targets()?.chats[0]?.id ?? null}
                    options={[
                      ...(targets()?.chats ?? []).map((chat) => ({
                        value: chat.id,
                        label: chat.label,
                        group: t("route.chats"),
                      })),
                      ...(targets()?.channels ?? []).map((channel) => ({
                        value: channel.id,
                        label: channel.label,
                        group: t("route.channels"),
                      })),
                    ]}
                    onChange={setAnswerer}
                  />
                </div>
                <Show when={error()}>
                  <p class="zb-kit-error" role="alert">
                    {error()}
                  </p>
                </Show>
              </Stack>
            )}
          </Match>
          <Match when={screen().name === "bridge" && current()}>
            {(view) => <BridgeDetail view={view()} busy={busy()} error={error()} go={go} allow={allow} />}
          </Match>
          <Match when={screen().name === "route" && current() && targets()}>
            <RouteEditor
              view={current() as BridgeView}
              route={current()?.bridge.routes.find(
                (row) => row.id === (screen() as { routeId?: string }).routeId,
              )}
              targets={targets() as NonNullable<ReturnType<typeof targets>>}
              error={error()}
              ref={(read) => {
                readRoute = read;
              }}
            />
          </Match>
        </Switch>
      </Dialog>
      <Show when={removing()}>
        {(view) => (
          <ConfirmDialog
            title={t("bridges.removeTitle", { name: view().bridge.label })}
            body={t("bridges.removeBody")}
            confirmLabel={t("bridges.remove")}
            busyLabel={t("bridges.removing")}
            danger
            busy={busy()}
            error={error()}
            onConfirm={() => void remove()}
            onCancel={() => setRemoving(null)}
          />
        )}
      </Show>
    </>
  );
}

type AllowPerson = (view: BridgeView, refusalId: string) => unknown;

function BridgeDetail(props: {
  view: BridgeView;
  busy: boolean;
  error: string | null;
  go: (screen: Screen) => void;
  allow: AllowPerson;
}) {
  const target = (route: BridgeRoute) => {
    const to = route.to;
    return to.kind === "chat" ? to.threadId : to.channelId;
  };
  const [names] = createResource(() => window.openbot.bridges.targets());
  const targetName = (route: BridgeRoute) => {
    const all = [...(names()?.chats ?? []), ...(names()?.channels ?? [])];
    return all.find((row) => row.id === target(route))?.label ?? "";
  };
  return (
    <Stack gap={4}>
      <div class="bridge-status-line">
        <span class={`bridge-status bridge-status-${props.view.status.state}`}>
          <span class="bridge-dot" aria-hidden="true" />
          {statusLabel(props.view.status)}
        </span>
        <Show when={problemText(props.view.status) ?? props.view.status.account}>
          {(line) => (
            <span class="bridge-muted">
              <span aria-hidden="true">· </span>
              {line()}
            </span>
          )}
        </Show>
      </div>
      <section aria-labelledby="bridge-routes">
        <div class="bridge-section-head">
          <h3 id="bridge-routes">{t("bridges.routes")}</h3>
          <button
            type="button"
            class="zb-kit-button"
            disabled={props.busy}
            onClick={() => props.go({ name: "route", id: props.view.bridge.id })}
          >
            {t("bridges.addRoute")}
          </button>
        </div>
        <Show
          when={props.view.bridge.routes.length}
          fallback={<p class="bridge-muted">{t("bridges.noRoutes")}</p>}
        >
          <ul class="bridge-list">
            <For each={props.view.bridge.routes}>
              {(route) => (
                <li class="bridge-route">
                  <span class="bridge-row-name">
                    <strong>
                      {t("bridges.routeLine", {
                        from: placeLabel(route),
                        to: targetName(route),
                      })}
                    </strong>
                    <span>{t("bridges.people", { count: route.allow.length })}</span>
                  </span>
                  <button
                    type="button"
                    class="zb-kit-button"
                    aria-label={t("bridges.editRoute", { from: placeLabel(route) })}
                    onClick={() =>
                      props.go({ name: "route", id: props.view.bridge.id, routeId: route.id })
                    }
                  >
                    {t("bridges.edit")}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
      <Show when={props.view.refused.length}>
        <section aria-labelledby="bridge-refused">
          <h3 id="bridge-refused">{t("bridges.refused")}</h3>
          <ul class="bridge-list">
            <For each={props.view.refused}>
              {(entry) => (
                <li class="bridge-route">
                  <span class="bridge-row-name">
                    <strong>
                      {entry.person.name
                        ? t("bridges.person", { name: entry.person.name, id: entry.person.id })
                        : entry.person.id}
                    </strong>
                    <span>
                      {entry.place.id === BRIDGE_DIRECT || !entry.place.label
                        ? t("bridges.refusedDirect")
                        : t("bridges.refusedIn", { place: entry.place.label })}
                    </span>
                  </span>
                  <Show when={entry.routeId}>
                    <button
                      type="button"
                      class="zb-kit-button"
                      disabled={props.busy}
                      aria-label={t("bridges.allowPerson", {
                        name: entry.person.name || entry.person.id,
                      })}
                      onClick={() => void props.allow(props.view, entry.id)}
                    >
                      {t("bridges.allow")}
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.error}>
        <p class="zb-kit-error" role="alert">
          {props.error}
        </p>
      </Show>
    </Stack>
  );
}

