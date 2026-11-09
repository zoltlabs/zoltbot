import { useState } from "react";
import {
  Avatar,
  Button,
  Card,
  Chip,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Kbd,
  ListRow,
  Menu,
  Meter,
  PipelineStage,
  Popover,
  PropertyList,
  SectionLabel,
  Select,
  Spinner,
  type Status,
  StatusDot,
  statusLabels,
  Tabs,
  Textarea,
  type Tone,
  Tooltip,
} from "./primitives.js";

const tones: [Tone, string][] = [
  ["neutral", "Draft"],
  ["accent", "Running"],
  ["ok", "Passed"],
  ["warn", "Waiting"],
  ["danger", "Failed"],
  ["attention", "Needs you"],
  ["gate", "Human gate"],
];
const statuses = Object.keys(statusLabels) as Status[];

export default function Gallery() {
  const [tab, setTab] = useState("context");
  const [view, setView] = useState("list");
  const [count, setCount] = useState(0);
  const [row, setRow] = useState("Inbox");
  const [dialog, setDialog] = useState(false);
  const [last, setLast] = useState("None yet");
  return (
    <div className="component-gallery">
      <header>
        <h1>Visual language</h1>
        <p>The v3 component kit. Every value comes from the shared --zb tokens.</p>
      </header>

      <Card className="gallery-section">
        <h2>Buttons</h2>
        <div className="gallery-row">
          <Button variant="primary" kbd="⌘↵" onClick={() => setCount((n) => n + 1)}>
            Primary action
          </Button>
          <Button icon="Plus">Secondary action</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Reject</Button>
          <Button disabled>Unavailable</Button>
          <Chip>Actions: {count}</Chip>
        </div>
        <div className="gallery-row">
          <Button size="sm">Small</Button>
          <Button>Medium</Button>
          <Button size="lg">Large</Button>
          <IconButton label="Search" icon="Search" />
          <IconButton label="Copy" icon="Copy" variant="secondary" />
          <IconButton label="Settings" icon="Settings" size="sm" />
        </div>
      </Card>

      <Card className="gallery-section">
        <h2>Inputs</h2>
        <div className="gallery-grid">
          <Field label="Profile name" hint="Shown in the sidebar and in chat.">
            <Input placeholder="Reviewer" />
          </Field>
          <Field label="Model">
            <Select defaultValue="balanced">
              <option value="fast">Fast</option>
              <option value="balanced">Balanced</option>
              <option value="deep">Deep</option>
            </Select>
          </Field>
          <Field label="Instructions">
            <Textarea rows={3} placeholder="What should this profile focus on?" />
          </Field>
        </div>
      </Card>

      <Card className="gallery-section">
        <h2>Status</h2>
        <div className="gallery-row">
          {tones.map(([tone, label]) => (
            <Chip key={tone} tone={tone} dot={tone !== "neutral"}>
              {label}
            </Chip>
          ))}
        </div>
        <div className="gallery-row">
          {statuses.map((status) => (
            <span className="gallery-row" key={status}>
              <StatusDot status={status} label={false} />
              <span className="gallery-note">{statusLabels[status]}</span>
            </span>
          ))}
        </div>
        <div className="gallery-row">
          <Avatar name="Design profile" hue={1} size={24} status="working" />
          <Avatar name="Build profile" hue={2} size={24} status="needs_you" />
          <Avatar name="Review profile" hue={4} size={24} />
          <Avatar name="Research profile" hue={6} size={20} status="blocked" />
          <Avatar name="Ops profile" hue={7} size={16} />
          <Spinner label="Loading profiles" />
          <span className="gallery-note">Profile identity and status stay distinct.</span>
        </div>
        <div className="gallery-row">
          {["claude", "codex", "antigravity", "cursor", "opencode", "pi:deepseek"].map(
            (tool, n) => (
              <Avatar
                key={tool}
                name={`${tool} profile`}
                id={`gallery-${tool}`}
                hue={n + 1}
                size={24}
                tool={tool}
                {...(n === 0
                  ? { status: "working" as const }
                  : n === 1
                    ? { status: "needs_you" as const }
                    : {})}
              />
            ),
          )}
          <Avatar name="Small profile" id="gallery-small" hue={7} size={20} tool="claude" />
          <Avatar name="Tiny profile" id="gallery-tiny" hue={8} size={16} tool="codex" />
          <span className="gallery-note">Agents show their coding tool, ringed in their hue.</span>
        </div>
      </Card>

      <Card className="gallery-section">
        <h2>Rows and properties</h2>
        <div className="gallery-grid">
          <div className="gallery-column">
            <SectionLabel>Workspace</SectionLabel>
            <nav className="gallery-list" aria-label="Example navigation">
              {(["Home", "Inbox", "Tasks", "Projects"] as const).map((name) => (
                <ListRow
                  key={name}
                  icon={name}
                  label={name}
                  current={row === name}
                  trailing={name === "Inbox" ? <Chip tone="attention">3</Chip> : undefined}
                  onClick={() => setRow(name)}
                />
              ))}
              <ListRow
                indent={1}
                label="zoltbot"
                leading={<StatusDot status="working" label={false} />}
                trailing="2"
              />
              <ListRow
                indent={1}
                label="marketing site"
                leading={<StatusDot status="idle" label={false} />}
              />
            </nav>
          </div>
          <div className="gallery-column">
            <SectionLabel>Run</SectionLabel>
            <PropertyList
              items={[
                { label: "Profile", value: "Reviewer" },
                { label: "Model", value: "Balanced" },
                { label: "Status", value: <Chip tone="accent">Running</Chip> },
                { label: "Started", value: "2 minutes ago" },
              ]}
            />
          </div>
        </div>
      </Card>

      <div className="gallery-grid">
        <Card className="gallery-section">
          <h2>Card</h2>
          <p className="gallery-note">A hairline surface. No shadow, no gradient.</p>
        </Card>
        <Card tone="attention" className="gallery-section">
          <h2>Attention card</h2>
          <p className="gallery-note">Used when a profile is waiting on you.</p>
        </Card>
        <Card className="gallery-section">
          <EmptyState
            icon="Inbox"
            title="Nothing needs you"
            action={<Button size="sm">Open inbox</Button>}
          >
            Requests from profiles will show up here.
          </EmptyState>
        </Card>
      </div>

      <Card className="gallery-section">
        <h2>Menus and overlays</h2>
        <div className="gallery-row">
          <Menu
            label="Profile actions"
            items={[
              { label: "Rename", icon: "Edit", kbd: "R", onSelect: () => setLast("Rename") },
              { label: "Duplicate", icon: "Plus", onSelect: () => setLast("Duplicate") },
              {
                label: "Delete",
                icon: "Delete",
                danger: true,
                onSelect: () => setLast("Delete"),
              },
            ]}
          />
          <Popover label="Filter options" trigger="Filter">
            <Field label="Search profiles">
              <Input placeholder="Name or tag" />
            </Field>
          </Popover>
          <Tooltip label="Open the command palette">
            <Button variant="ghost" kbd="⌘K">
              Commands
            </Button>
          </Tooltip>
          <Button onClick={() => setDialog(true)}>Open dialog</Button>
          <span className="gallery-note">Last menu choice: {last}</span>
        </div>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Stop this run?"
          description="The profile keeps its work so far. You can resume it later."
          actions={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setDialog(false)}>
                Stop run
              </Button>
            </>
          }
        />
        <p className="gallery-note">
          Keyboard hints use <Kbd>Esc</Kbd> and <Kbd>⌘K</Kbd>.
        </p>
      </Card>

      <Card className="gallery-section">
        <h2>Tabs and progress</h2>
        <div className="gallery-row">
          <div className="gallery-meter">
            <div>
              <span>Context window</span>
              <span>38 percent</span>
            </div>
            <Meter label="Context window" value={38} />
          </div>
          <div className="gallery-meter">
            <div>
              <span>Budget</span>
              <span>82 percent</span>
            </div>
            <Meter label="Budget" value={82} tone="warn" />
          </div>
        </div>
        <Tabs
          label="Run information"
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: "context",
              label: "Context",
              content: "Instructions and context added to this run.",
            },
            { id: "run", label: "Run", content: "The task, checks, and current state." },
            { id: "knowledge", label: "Knowledge", content: "Included knowledge and its sources." },
          ]}
        />
        <Tabs
          label="Layout"
          variant="segmented"
          value={view}
          onChange={setView}
          tabs={[
            { id: "list", label: "List", content: "Rows, newest first." },
            { id: "board", label: "Board", content: "Columns by status." },
          ]}
        />
      </Card>

      <section className="gallery-section" aria-label="Pipeline component examples">
        <h2>Pipeline stages and gates</h2>
        <div className="gallery-pipeline">
          <PipelineStage
            name="Design"
            profile="Designer"
            status="passed"
            description="Approved design files."
          />
          <PipelineStage
            name="Build"
            profile="Builder"
            status="running"
            description="Implementing the approved design."
          />
          <PipelineStage
            name="Review"
            profile="Reviewer"
            status="at_gate"
            description="Waiting for the final outcome review."
          />
        </div>
      </section>
    </div>
  );
}
