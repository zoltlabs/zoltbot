import type { ReactNode } from "react";
import { Icon } from "../shell/icons.js";
import "./message-details.css";

/** Native disclosure: hover reveals the control; focus and touch work without a pointer. */
export function MessageDetails({ children }: { children: ReactNode }) {
  return (
    <details className="message-details">
      <summary>
        <Icon name="Info" size="sm" />
        Message details
      </summary>
      <div className="message-details-content">{children}</div>
    </details>
  );
}
