import { useEffect, useId, useRef, useState } from "react";
import { Button, Field, Input } from "../components/primitives.js";
import type { CloudSecretName, CloudSettingsBridge } from "./types.js";

export function SecretForm({
  bridge,
  sessionId,
  name,
  label,
  disabled,
}: {
  bridge: CloudSettingsBridge;
  sessionId: string;
  name: CloudSecretName;
  label: string;
  disabled: boolean;
}) {
  const id = useId(),
    input = useRef<HTMLInputElement>(null),
    mounted = useRef(true),
    pending = useRef(false);
  const [value, setValue] = useState(""),
    [busy, setBusy] = useState(false),
    [invalid, setInvalid] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      className="cloud-secret-form"
      aria-label={`Save ${label}`}
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || pending.current) return;
        setError("");
        setMessage("");
        const key = value.trim();
        if (!key) {
          setInvalid(true);
          setError("Enter a key.");
          input.current?.focus();
          return;
        }
        setInvalid(false);
        pending.current = true;
        setBusy(true);
        setMessage("Saving…");
        try {
          await bridge.saveSecret({ sessionId, name, value: key });
          if (mounted.current) {
            setValue("");
            setMessage("Key saved.");
          }
        } catch {
          if (mounted.current) {
            setMessage("");
            setError("Could not save the key. Check your connection and retry.");
          }
        } finally {
          pending.current = false;
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <Field label={label}>
        <Input
          ref={input}
          id={id}
          name={`cloud-${name}`}
          type="password"
          value={value}
          maxLength={65536}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          disabled={disabled}
          readOnly={busy}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
            setError("");
            setMessage("");
          }}
        />
      </Field>
      {error ? (
        <p id={`${id}-error`} role={invalid ? undefined : "alert"}>
          {error}
        </p>
      ) : null}
      <div className="r wrap">
        <Button
          type="submit"
          disabled={disabled}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          aria-label={`Save ${label}`}
        >
          Save
        </Button>
        <output>{message}</output>
      </div>
    </form>
  );
}
