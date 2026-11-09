import { ArtifactSchema, type ArtifactTarget, parse } from "@zoltbot/protocol";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatConnection } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { ArtifactPanel, ArtifactPreview } from "./Artifacts.js";
import type { TimelineRow } from "./occurrences.js";
import { useInlinePreviews, usePreviewSlot } from "./preview-lifecycle.js";

export function InlineArtifact({
  connection,
  row,
  onRevise,
  expanded,
  setExpanded,
}: {
  connection: ChatConnection;
  row: Extract<TimelineRow, { type: "artifact" }>;
  onRevise?: ((target: ArtifactTarget) => void) | undefined;
  expanded: boolean;
  setExpanded(value: boolean): void;
}) {
  const artifact = parse(ArtifactSchema, row.artifact);
  const latest = String(row.versions.at(-1)?.id);
  const [selected, setSelected] = useState(latest);
  const node = useRef<HTMLElement>(null);
  const version = row.versions.find((v) => v.id === selected);
  const enabled = useInlinePreviews();
  const previewable = ["page", "design", "chart", "diagram", "image"].includes(artifact.kind);
  const slot = usePreviewSlot(
    node,
    enabled && previewable && !expanded && !version?.metadataOnly && !version?.held,
  );
  return (
    <article
      ref={node}
      className="artifact-card artifact-inline"
      aria-label={`${artifact.title} visual`}
    >
      <div className="artifact-toolbar">
        <strong>{artifact.title}</strong>
        <span>
          {artifact.kind} · v{Number(version?.number)}
        </span>
        <Button size="sm" onClick={() => setExpanded(true)}>
          Expand {artifact.title}
        </Button>
        <Button
          size="sm"
          disabled={!onRevise || !!version?.held || !!version?.metadataOnly}
          title={
            onRevise
              ? "Use this exact version as the next message's reference."
              : "Use task review, or start a new artifact-enabled chat to revise a version."
          }
          onClick={() => onRevise?.({ artifactId: artifact.id, versionId: selected })}
        >
          Revise this version
        </Button>
      </div>
      {artifact.currentVersionId !== selected ? (
        <p className="dim">Newer version available in artifact history.</p>
      ) : null}
      {selected !== latest ? (
        <Button size="sm" onClick={() => setSelected(latest)}>
          View v{Number(row.versions.at(-1)?.number)} from this turn
        </Button>
      ) : null}
      {slot ? (
        <ArtifactPreview connection={connection} artifact={artifact} versionId={selected} />
      ) : (
        <p className="dim">
          {version?.metadataOnly
            ? "Files not available on this Mac."
            : enabled && previewable
              ? "Preview paused. Expand to interact. Controls reset when paused."
              : "Open this version to view it."}
        </p>
      )}
      {expanded
        ? createPortal(
            <div className="artifact-inline-panel">
              <ArtifactPanel
                connection={connection}
                artifact={artifact}
                initialVersionId={selected}
                onRevise={onRevise}
                close={() => setExpanded(false)}
              />
            </div>,
            document.body,
          )
        : null}
    </article>
  );
}
