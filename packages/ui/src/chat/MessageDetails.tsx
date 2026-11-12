import type { ReactNode } from "react";
import { Icon } from "../shell/icons.js";
import "./message-details.css";

/** Native disclosure stays visible and works with pointer, keyboard and touch. */
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
