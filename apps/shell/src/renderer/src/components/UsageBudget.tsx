// S6: a project's budget on the Usage page, saved with budget.set. Nothing enforces it yet.
import { createSignal, Show } from "solid-js";
import type { SpendBudget } from "../../../shared/spend";
import { t } from "../i18n";
import { formatUsd } from "../spend";
import type { SpendChange } from "../spend-store";

export function UsageBudget(props: {
  project: { id: string; name: string };
  budget: SpendBudget | undefined;
  onSave: (usd: number) => SpendChange;
}) {
  const [editing, setEditing] = createSignal(false);
  const [amount, setAmount] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let edit: HTMLButtonElement | undefined;

  function start() {
    setAmount(props.budget?.usd === undefined ? "" : String(props.budget.usd));
    setError(null);
    setEditing(true);
    input?.focus();
  }

  function stop() {
    setEditing(false);
    setError(null);
    queueMicrotask(() => edit?.focus());
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const text = amount().trim().replace(/,/g, "");
    const usd = Number(text);
    if (!/^\d+(\.\d{1,2})?$/.test(text) || usd > 1_000_000) {
      setError(t("usage.budget.invalid"));
      input?.focus();
      return;
    }
    setBusy(true);
    const failure = await props.onSave(usd);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    stop();
  }

  return (
    <section class="usage-budget" aria-labelledby="usage-budget-title">
      <h2 id="usage-budget-title" class="usage-budget-title">
        {t("usage.budget.title", { project: props.project.name })}
      </h2>
      <Show
        when={editing()}
        fallback={
          <div class="usage-budget-row">
            <span>
              {props.budget?.usd === undefined
                ? t("usage.budget.none")
                : t("usage.budget.value", { amount: formatUsd(props.budget.usd) })}
            </span>
            <button ref={edit} type="button" class="zb-kit-button" onClick={start}>
              {props.budget?.usd === undefined ? t("usage.budget.set") : t("usage.budget.edit")}
            </button>
          </div>
        }
      >
        <form class="usage-budget-row" onSubmit={save}>
          <label class="usage-budget-field">
            <span class="sr-only">{t("usage.budget.amount")}</span>
            <span aria-hidden="true">$</span>
            <input
              ref={input}
              class="zb-kit-input"
              inputMode="decimal"
              value={amount()}
              aria-invalid={error() ? true : undefined}
              aria-describedby={error() ? "usage-budget-error" : undefined}
              onInput={(event) => setAmount(event.currentTarget.value)}
            />
          </label>
          <button type="submit" class="zb-kit-button primary" disabled={busy()}>
            {t("usage.budget.save")}
          </button>
          <button type="button" class="zb-kit-button" disabled={busy()} onClick={stop}>
            {t("usage.budget.cancel")}
          </button>
        </form>
      </Show>
      <Show when={error()}>
        <p id="usage-budget-error" class="memory-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}
