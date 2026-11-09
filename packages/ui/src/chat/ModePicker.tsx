import { useId, useRef, useState } from "react";
import { Dialog } from "../components/primitives.js";
import { modeDescription, modeLabel, nextMode, widensPermissions } from "./mode-data.js";
import type { ChatConnection } from "./types.js";
import "./parity.css";

export interface ModeControl {
  modes: string[];
  current: string;
  pending: string | undefined;
  error: string;
  disabled: boolean;
  /** Asks for confirmation first when the mode widens permissions (I13). */
  request(mode: string): void;
  /** Shift+Tab: the next safe mode. False when there is nothing to switch to. */
  cycle(): boolean;
  widens(mode: string): boolean;
  confirming: string | undefined;
  confirm(): void;
  cancel(): void;
}
export function useModeControl(
  connection: ChatConnection,
  sessionId: string | undefined,
  modes: string[],
  current: string,
  safeModes: string[] | undefined,
): ModeControl {
  const [pending, setPending] = useState<string>(),
    [confirming, setConfirming] = useState<string>(),
    [error, setError] = useState("");
  const attempt = useRef<{ mode: string; id: string } | undefined>(undefined);
  const disabled = !sessionId || connection.status !== "online" || !!pending;
  const apply = async (mode: string, confirmed: boolean) => {
    if (!sessionId || mode === current) return;
    const widens = widensPermissions(mode, safeModes);
    if (widens && !confirmed) {
      setConfirming(mode);
      return;
    }
    if (attempt.current?.mode !== mode) attempt.current = { mode, id: crypto.randomUUID() };
    setPending(mode);
    setError("");
    try {
      await connection.call(
        "session.setMode",
        { id: sessionId, mode, ...(widens ? { confirmed: true } : {}) },
        attempt.current.id,
      );
      attempt.current = undefined;
    } catch {
      setError("The mode change could not be confirmed. The current mode is shown.");
    } finally {
      setPending(undefined);
    }
  };
  return {
    modes,
    current,
    pending,
    error,
    disabled,
    confirming,
    request: (mode) => {
      if (!disabled) void apply(mode, false);
    },
    cycle: () => {
      const next = nextMode(modes, current, safeModes);
      if (!next || disabled) return false;
      void apply(next, false);
      return true;
    },
    widens: (mode) => widensPermissions(mode, safeModes),
    confirm: () => {
      const mode = confirming;
      setConfirming(undefined);
      if (mode) void apply(mode, true);
    },
    cancel: () => setConfirming(undefined),
  };
}

export function ModePicker({ control }: { control: ModeControl }) {
  const id = useId();
  const shown = control.pending ?? control.current;
  const options = control.modes.includes(control.current)
    ? control.modes
    : [control.current, ...control.modes];
  return (
    <>
      <label
        className={`chat-mode${control.widens(shown) ? " wide" : ""}`}
        title={`${modeDescription(shown)} Shift+Tab switches modes.`.trim()}
      >
        <span className="tool-sr">Permission mode</span>
        <select
          aria-label="Permission mode"
          aria-describedby={control.error ? `${id}-error` : undefined}
          aria-keyshortcuts="Shift+Tab"
          value={shown}
          disabled={control.disabled}
          onChange={(event) => {
            const requested = event.currentTarget.value;
            // Keep the effective mode selected while a widening request awaits confirmation.
            event.currentTarget.value = shown;
            control.request(requested);
          }}
        >
          {options.map((mode) => (
            <option key={mode} value={mode}>
              {modeLabel(mode)}
            </option>
          ))}
        </select>
        {control.pending ? <span aria-live="polite">Switching…</span> : null}
      </label>
      {control.error ? (
        <span id={`${id}-error`} className="chat-mode-error" role="alert">
          {control.error}
        </span>
      ) : null}
      <Dialog
        open={!!control.confirming}
        title={`Switch to ${modeLabel(control.confirming ?? "")}?`}
        description={`${
          modeDescription(control.confirming ?? "") ||
          "Your coding tool will do more without asking you first."
        } Use it only in a folder you trust, and switch back when you are done.`}
        onClose={control.cancel}
        actions={
          <>
            <button type="button" className="btn" onClick={control.cancel}>
              Cancel
            </button>
            <button type="button" className="btn chat-danger-fill" onClick={control.confirm}>
              Switch to {modeLabel(control.confirming ?? "")}
            </button>
          </>
        }
      />
    </>
  );
}
