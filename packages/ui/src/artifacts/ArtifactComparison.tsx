import type { ArtifactTarget } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import type { ChatConnection } from "../chat/types.js";
import { Button, Dialog } from "../components/primitives.js";
import { useShell } from "../state.js";
import { ArtifactPreview } from "./Artifacts.js";
import { type VisualOption, visualOptions } from "./comparison-data.js";
import { usePreviewSlot } from "./preview-lifecycle.js";
import "./comparison.css";

export function ArtifactComparison({
  connection,
  threadIds,
  onClose,
  onChoose,
}: {
  connection: ChatConnection;
  threadIds: string[];
  onClose(): void;
  onChoose?: ((target: ArtifactTarget) => void) | undefined;
}) {
  const entities = connection.snapshot.entities;
  const options = visualOptions(entities.artifact ?? [], entities.artifactVersion ?? [], threadIds);
  const [left, setLeft] = useState(options[0]?.version.id ?? ""),
    [right, setRight] = useState(options[1]?.version.id ?? "");
  const [feedback, setFeedback] = useState("");
  const stage = useRef<HTMLDivElement>(null);
  const slot = usePreviewSlot(stage, options.length > 1, true);
  const a = options.find((option) => option.version.id === left),
    b = options.find((option) => option.version.id === right);
  const choose = (option: VisualOption) => {
    if (!onChoose) return;
    const target = { artifactId: option.artifact.id, versionId: option.version.id };
    const reference = `Use “${option.artifact.title}” v${option.version.number} (${option.version.id})${feedback.trim() ? `: ${feedback.trim()}` : "."}`;
    // Prepare a normal composer draft; choosing a version never sends a message or accepts work.
    useShell.setState({ chatDraft: { threadId: option.artifact.threadId, text: reference } });
    onChoose(target);
    onClose();
  };
  return (
    <Dialog
      open
      wide
      title="Compare artifacts"
      onClose={onClose}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      {options.length < 2 ? (
        <p>Two available versions are needed to compare.</p>
      ) : (
        <>
          <div className="artifact-comparison" ref={stage}>
            {[
              { value: left, set: setLeft, option: a, label: "Baseline" },
              { value: right, set: setRight, option: b, label: "Alternative" },
            ].map(({ value, set, option, label }) => (
              <section className="artifact-comparison-side" key={label} aria-label={label}>
                <label className="artifact-comparison-label">
                  {label}
                  <select
                    aria-label={`${label} version`}
                    value={value}
                    onChange={(event) => set(event.target.value)}
                  >
                    {options.map((entry) => (
                      <option key={entry.version.id} value={entry.version.id}>
                        {entry.artifact.title} · v{entry.version.number}
                      </option>
                    ))}
                  </select>
                </label>
                {option ? (
                  <>
                    <div className="artifact-comparison-preview">
                      {slot ? (
                        <ArtifactPreview
                          key={option.version.id}
                          connection={connection}
                          artifact={option.artifact}
                          versionId={option.version.id}
                          controls
                        />
                      ) : (
                        <p>Preparing comparison…</p>
                      )}
                    </div>
                    {onChoose ? (
                      <Button size="sm" disabled={left === right} onClick={() => choose(option)}>
                        Use {label.toLowerCase()}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p>Version unavailable. Choose another version.</p>
                )}
              </section>
            ))}
          </div>
          {left === right ? <output>Choose two different versions.</output> : null}
          {onChoose ? (
            <label className="artifact-comparison-feedback">
              Feedback
              <textarea
                className="zb-input"
                rows={2}
                value={feedback}
                onChange={(event) => setFeedback(event.target.value)}
                placeholder="What should change?"
              />
            </label>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
