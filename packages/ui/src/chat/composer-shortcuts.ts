import { useEffect, useState } from "react";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = mac ? "⌘" : "Ctrl";

/** Whether ⌘ (Ctrl elsewhere) is held, so the send button can show what a click will do. */
export function useModifierHeld(active: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const update = (event: KeyboardEvent) => setHeld(mac ? event.metaKey : event.ctrlKey);
    const clear = () => setHeld(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", clear);
    };
  }, [active]);
  return held;
}
