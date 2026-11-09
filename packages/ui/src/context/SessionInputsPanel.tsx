import type { ReactNode } from "react";
import type { ChatConnection, Row } from "../chat/types.js";

export interface ContextSectionProps {
  connection: ChatConnection;
  task: Row;
  mode: "preview" | "frozen";
}
export interface ContextSection {
  id: string;
  title: string;
  render(props: ContextSectionProps): ReactNode;
}
const sections = new Map<string, ContextSection>();
/** Feature modules register once at import; no feature replaces another section. */
export function registerContextSection(section: ContextSection) {
  if (sections.has(section.id)) throw new Error(`duplicate_context_section: ${section.id}`);
  sections.set(section.id, section);
}
export const contextLabels = {
  preview: "Preview · checked again at start",
  frozen: "Since start",
  unknown: "Not reported",
  changed: "Changed since start. New sessions use the latest version.",
} as const;
export function TokenMeter({ used, budget }: { used: number; budget: number }) {
  return (
    <p className="dim sm">
      {used.toLocaleString()} of {budget.toLocaleString()} tokens (estimated)
    </p>
  );
}
export function SessionInputsPanel(props: ContextSectionProps) {
  return (
    <details className="zb-card session-inputs">
      <summary>Session inputs · {contextLabels[props.mode]}</summary>
      <p className="dim sm">Inputs are fixed when the native session starts.</p>
      {[...sections.values()]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((section) => (
          <section key={section.id} aria-label={section.title}>
            <h4>{section.title}</h4>
            {section.render(props)}
          </section>
        ))}
    </details>
  );
}
export const TaskContextPanel = SessionInputsPanel;
