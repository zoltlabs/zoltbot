import {
  type ComponentProps,
  cloneElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon, type IconSize } from "../shell/icons.js";
import { avatarHue, initials, useProfileHue } from "./identity.js";
import { ToolLogo, toolLogo } from "./ToolLogo.js";

type Size = "sm" | "md" | "lg";

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="zb-kbd">{children}</kbd>;
}

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  kbd,
  className = "",
  children,
  ...props
}: ComponentProps<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: Size;
  icon?: string;
  kbd?: string;
}) {
  return (
    <button
      type="button"
      {...props}
      className={`zb-button ${variant} ${size} ${className}`.trimEnd()}
    >
      {icon ? <Icon name={icon} size={size === "lg" ? "md" : "sm"} /> : null}
      {children}
      {kbd ? <Kbd>{kbd}</Kbd> : null}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  label: string;
  icon: string;
  variant?: "ghost" | "secondary";
  size?: Size;
}) {
  return (
    <button
      type="button"
      title={label}
      {...props}
      aria-label={label}
      className={`zb-button zb-icon-button ${variant} ${size} ${className}`.trimEnd()}
    >
      <Icon name={icon} size={size === "lg" ? "md" : "sm"} />
    </button>
  );
}

/** A labelled form control; the label wraps the control so no id wiring is needed. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children, which the label wraps.
    <label className="zb-field">
      <span className="zb-field-label">{label}</span>
      {children}
      {hint ? <span className="zb-field-hint">{hint}</span> : null}
    </label>
  );
}
export function Input({
  size = "md",
  className = "",
  ...props
}: Omit<ComponentProps<"input">, "size"> & { size?: "md" | "lg" }) {
  return <input {...props} className={`zb-input ${size} ${className}`.trimEnd()} />;
}
export function Textarea({ className = "", ...props }: ComponentProps<"textarea">) {
  return <textarea {...props} className={`zb-input zb-textarea ${className}`.trimEnd()} />;
}
export function Select({
  size = "md",
  className = "",
  ...props
}: Omit<ComponentProps<"select">, "size"> & { size?: "md" | "lg" }) {
  return <select {...props} className={`zb-input zb-select ${size} ${className}`.trimEnd()} />;
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "attention" | "gate";
export function Chip({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`zb-chip ${tone}`}>
      {dot ? <span className="zb-chip-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export type Status =
  | "idle"
  | "working"
  | "queued"
  | "needs_you"
  | "done"
  | "blocked"
  | "error"
  | "offline";
export const statusLabels: Record<Status, string> = {
  idle: "Idle",
  working: "Working",
  queued: "Queued",
  needs_you: "Needs you",
  done: "Done",
  blocked: "Blocked",
  error: "Error",
  offline: "Offline",
};
export function StatusDot({ status, label = true }: { status: Status; label?: boolean }) {
  return label ? (
    <span className={`zb-status-dot ${status}`} role="img" aria-label={statusLabels[status]} />
  ) : (
    <span className={`zb-status-dot ${status}`} aria-hidden="true" />
  );
}

export function Avatar({
  name,
  id,
  hue,
  size = 20,
  status,
  tool,
}: {
  name: string;
  /** Profile id; picks the hue, spread across known profiles. */
  id?: string;
  hue?: number;
  size?: 16 | 20 | 24;
  status?: Status;
  /** Agent definition id; draws that coding tool's logo instead of initials when one is bundled. */
  tool?: string | undefined;
}) {
  const spread = useProfileHue(id);
  const color = Math.min(8, Math.max(1, hue ?? spread ?? avatarHue(id ?? name)));
  const label = status ? `${name}, ${statusLabels[status].toLowerCase()}` : name;
  return (
    <span className={`zb-avatar s${size}`} role="img" aria-label={label}>
      {tool && toolLogo(tool) ? (
        <span className={`zb-avatar-tool h${color}`} aria-hidden="true">
          <ToolLogo tool={tool} size={size === 24 ? 14 : size === 20 ? 12 : 10} />
        </span>
      ) : (
        <span className={`zb-avatar-face h${color}`} aria-hidden="true">
          {size > 16 ? initials(name) : initials(name).slice(0, 1)}
        </span>
      )}
      {status ? <StatusDot status={status} label={false} /> : null}
    </span>
  );
}

/** The 28 px row shared by the sidebar, inbox, sessions and the palette. */
export function ListRow({
  label,
  icon,
  leading,
  trailing,
  selected = false,
  current = false,
  indent = 0,
  className = "",
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  label: ReactNode;
  icon?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  /** Marks the row for the page that is open, for nav lists. */
  current?: boolean;
  indent?: number;
}) {
  return (
    <button
      type="button"
      {...props}
      aria-current={current ? "page" : undefined}
      data-indent={indent || undefined}
      className={`zb-row${selected || current ? " on" : ""} ${className}`.trimEnd()}
    >
      {leading ?? (icon ? <Icon name={icon} size="md" /> : null)}
      <span className="zb-row-label">{label}</span>
      {trailing !== undefined ? <span className="zb-row-trailing">{trailing}</span> : null}
    </button>
  );
}

export function PropertyList({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="zb-properties">
      {items.map((item) => (
        <div className="zb-property" key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Card({
  tone = "plain",
  className = "",
  ...props
}: ComponentProps<"section"> & { tone?: "plain" | "attention" }) {
  return <section {...props} className={`zb-card ${tone} ${className}`.trimEnd()} />;
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="zb-section-label">{children}</h3>;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  level = 2,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  /** Use 1 when the empty state is the whole page. */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="zb-empty">
      {icon ? (
        <span className="zb-empty-icon">
          <Icon name={icon} size="lg" />
        </span>
      ) : null}
      <Heading>{title}</Heading>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Spinner({ label = "Loading", size = "md" }: { label?: string; size?: IconSize }) {
  return <output className={`zb-spinner ${size}`} aria-label={label} />;
}

export function Meter({
  label,
  value,
  tone = "accent",
}: {
  label: string;
  value: number;
  tone?: "accent" | "warn" | "danger";
}) {
  const percent = Math.min(100, Math.max(0, value));
  return (
    <div
      className={`zb-meter ${tone}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}
export function Tabs({
  label,
  tabs,
  value,
  onChange,
  variant = "underline",
}: {
  label: string;
  tabs: Tab[];
  value: string;
  onChange: (id: string) => void;
  variant?: "underline" | "segmented";
}) {
  const id = useId();
  const selected = tabs.find((tab) => tab.id === value) ?? tabs[0];
  return (
    <div className="zb-tabs-root">
      <div className={`zb-tabs ${variant}`} role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            key={tab.id}
            id={`${id}-tab-${tab.id}`}
            aria-selected={tab.id === selected?.id}
            aria-controls={`${id}-panel-${tab.id}`}
            className="zb-tab"
            tabIndex={tab.id === selected?.id ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              let target: number | undefined;
              if (event.key === "ArrowRight") target = (index + 1) % tabs.length;
              if (event.key === "ArrowLeft") target = (index + tabs.length - 1) % tabs.length;
              if (event.key === "Home") target = 0;
              if (event.key === "End") target = tabs.length - 1;
              if (target !== undefined) {
                event.preventDefault();
                const next = tabs[target];
                if (next) {
                  onChange(next.id);
                  document.getElementById(`${id}-tab-${next.id}`)?.focus();
                }
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          hidden={tab.id !== selected?.id}
          className="zb-tab-panel"
          role="tabpanel"
          id={`${id}-panel-${tab.id}`}
          aria-labelledby={`${id}-tab-${tab.id}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI ARIA requires a focusable panel when its content has no focusable descendants.
          tabIndex={0}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

/** Closes a floating surface on Escape or a press outside it, returning focus to its trigger. */
function useDismiss(
  open: boolean,
  close: () => void,
  root: RefObject<HTMLElement | null>,
  trigger: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", press);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", press);
      document.removeEventListener("keydown", key);
    };
  }, [open, close, root, trigger]);
}

export interface MenuItem {
  label: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  onSelect: () => void;
}
export function Menu({
  label,
  items,
  icon = "More",
}: {
  /** Accessible name of the trigger. */
  label: string;
  items: MenuItem[];
  icon?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), root, trigger);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  return (
    <div className="zb-float-root" ref={root}>
      <IconButton
        ref={trigger}
        label={label}
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div
          className="zb-menu"
          role="menu"
          id={id}
          aria-label={label}
          ref={list}
          tabIndex={-1}
          onKeyDown={(event) => {
            const entries = [
              ...(list.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []),
            ];
            const at = entries.indexOf(document.activeElement as HTMLElement);
            const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
            if (step) {
              event.preventDefault();
              entries[(at + step + entries.length) % entries.length]?.focus();
            }
            if (event.key === "Home") entries[0]?.focus();
            if (event.key === "End") entries.at(-1)?.focus();
            if (event.key === "Tab") setOpen(false);
          }}
        >
          {items.map((item) => (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              key={item.label}
              className={`zb-menu-item${item.danger ? " danger" : ""}`}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
                item.onSelect();
              }}
            >
              {item.icon ? <Icon name={item.icon} size="md" /> : null}
              <span className="zb-row-label">{item.label}</span>
              {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Popover({
  label,
  trigger: triggerContent,
  children,
}: {
  label: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, trigger);
  return (
    <div className="zb-float-root" ref={root}>
      <Button
        ref={trigger}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {triggerContent}
      </Button>
      {open ? (
        <div className="zb-popover" role="dialog" id={id} aria-label={label}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** Shows a short hint on hover and focus; the hint also describes the trigger for assistive tech. */
export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = useId();
  return (
    <span className="zb-tooltip-root">
      {cloneElement(children, { "aria-describedby": id })}
      <span className="zb-tooltip" role="tooltip" id={id}>
        {label}
      </span>
    </span>
  );
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
  /** Room for wide content such as diffs. */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(0);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) {
      closing.current++;
      dialog.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? "zb-dialog wide" : "zb-dialog"}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={() => {
        // A programmatic close event may arrive after this dialog has reopened.
        if (closing.current > 0) closing.current--;
        else onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {description ? <p id={descriptionId}>{description}</p> : null}
      {children}
      {actions ? <div className="zb-dialog-actions">{actions}</div> : null}
    </dialog>
  );
}

export function PipelineStage({
  name,
  profile,
  status,
  description,
}: {
  name: string;
  profile: string;
  status: "queued" | "running" | "passed" | "at_gate" | "failed";
  description: string;
}) {
  const labels = {
    queued: "Queued",
    running: "Running",
    passed: "Passed",
    at_gate: "Needs approval",
    failed: "Failed",
  };
  const tones: Record<typeof status, Tone> = {
    queued: "neutral",
    running: "accent",
    passed: "ok",
    at_gate: "gate",
    failed: "danger",
  };
  return (
    <article className={`zb-stage ${status}`} aria-label={`${name}: ${labels[status]}`}>
      <div className="zb-stage-head">
        <h3>{name}</h3>
        <Chip tone={tones[status]} dot>
          {labels[status]}
        </Chip>
      </div>
      <p>{description}</p>
      <div className="zb-stage-footer">
        <span>{profile}</span>
        <span>Deliverable handoff</span>
      </div>
    </article>
  );
}
