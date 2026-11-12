import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "../shell/icons.js";
import "./activity.css";

/** Routine work stays collapsed until opened; unresolved failures stay visible. */
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
  const [open, setOpen] = useState(failed);
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);
  return (
    <details className="activity-details" open={open}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supports keyboard activation; controlled state survives virtual row remeasurement. */}
      <summary
        onClick={(event) => {
          event.preventDefault();
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
