import { type ReactNode, useEffect, useRef, useState } from "react";
import { Icon } from "../shell/icons.js";
import "./activity.css";

/**
 * Routine execution is inspectable. Work in progress stays open so each step shows as it happens,
 * then closes to its summary unless you opened or closed it yourself. Failures stay open.
 */
export function ActivityDetails({
  label,
  running = false,
  failed = false,
  waiting = false,
  children,
}: {
  label: string;
  running?: boolean;
  failed?: boolean;
  waiting?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(failed || running);
  const chosen = useRef(false);
  useEffect(() => {
    if (failed) setOpen(true);
    else if (!chosen.current) setOpen(running);
  }, [failed, running]);
  return (
    <details className="activity-details" open={open}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supports keyboard activation; controlled state survives virtual row remeasurement. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
          chosen.current = true;
          setOpen((value) => !value);
        }}
      >
        <span className={running ? "chat-spin" : undefined} aria-hidden="true">
          <Icon name={failed || waiting ? "Alert" : running ? "Loader" : "Check"} size="sm" />
        </span>
        <output
          className={running ? "chat-shimmer" : undefined}
          aria-live={running ? "polite" : "off"}
        >
          {label}
        </output>
        <Icon name="ChevronRight" size="sm" />
      </summary>
      {children}
    </details>
  );
}
