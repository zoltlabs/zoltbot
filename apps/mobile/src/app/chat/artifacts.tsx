import type { ArtifactTarget } from "@zoltbot/protocol";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { comparisonVersions, revisionAvailable, versionDraft } from "../../data/artifacts";
import { text } from "../../data/view";
import { useChatDraft } from "../../state/chat-draft";
import { useSnapshot } from "../../state/link";
import { ArtifactPreview } from "../../ui/ArtifactPreview";
import { Choice, DetailScreen, Field } from "../../ui/DetailScreen";
import { Button, Card, Txt } from "../../ui/kit";

export default function ArtifactVersions() {
  const { id, versionId } = useLocalSearchParams<{ id: string; versionId?: string }>();
  const snapshot = useSnapshot();
  const options = comparisonVersions(snapshot, id);
  const [baseline, setBaseline] = useState(
    versionId ?? text(options[1]?.version.id ?? options[0]?.version.id),
  );
  const [alternative, setAlternative] = useState(
    text((versionId ? options.find((o) => o.version.id !== versionId) : options[0])?.version.id),
  );
  const [feedback, setFeedback] = useState("");
  const same = baseline === alternative;
  const choices = options.map((o) => ({
    value: text(o.version.id),
    label: `${o.label}${o.available ? "" : " · unavailable"}`,
  }));
  const choose = (option: (typeof options)[number]) => {
    const target: ArtifactTarget = {
      artifactId: text(option.artifact.id),
      versionId: text(option.version.id),
    };
    useChatDraft
      .getState()
      .prepare(id, versionDraft(text(option.artifact.title), option.version, feedback), target);
    router.navigate(`/chat/${encodeURIComponent(id)}`);
  };
  const readOnly =
    !revisionAvailable(snapshot, id) ||
    snapshot.entities.compareMember?.some((m) => m.threadId === id && m.ceiling === "read_only") ||
    snapshot.entities.compare?.some((g) => g.summaryThreadId === id);
  return (
    <DetailScreen title="Compare saved versions">
      <Txt>
        Review versions one above the other. Choosing a version prepares a message for you to send.
      </Txt>
      {readOnly ? (
        <Txt>
          Version selection is available in unarchived chats with artifact revision support. You can
          still inspect saved versions here.
        </Txt>
      ) : null}
      {!options.length ? (
        <Txt>No saved versions in this chat yet.</Txt>
      ) : options.length < 2 ? (
        <Txt>Only one saved version is available. A second version is needed to compare.</Txt>
      ) : null}
      {[
        { label: "Baseline", value: baseline, set: setBaseline },
        ...(options.length > 1
          ? [{ label: "Alternative", value: alternative, set: setAlternative }]
          : []),
      ].map((side) => {
        const option = options.find((o) => o.version.id === side.value);
        return (
          <Card key={side.label}>
            <Choice label={side.label} value={side.value} options={choices} onChange={side.set} />
            {option ? (
              <>
                <Txt v="cardTitle">{option.label}</Txt>
                {text(option.version.note) ? <Txt>{text(option.version.note)}</Txt> : null}
                <Txt tone="secondary">
                  {new Date(text(option.version.createdAt)).toLocaleString()} ·{" "}
                  {text(option.version.reviewState).replaceAll("_", " ")}
                </Txt>
                {option.available ? (
                  <ArtifactPreview
                    key={text(option.version.id)}
                    artifactId={text(option.artifact.id)}
                    versionId={text(option.version.id)}
                    label={option.label}
                  />
                ) : (
                  <Txt>
                    {option.version.held
                      ? "Held for review on Mac. Preview and revision are unavailable."
                      : "Files unavailable on the producing Mac."}
                  </Txt>
                )}
                {!readOnly ? (
                  <Button
                    label={`Use ${side.label.toLowerCase()}`}
                    disabled={!option.available || (options.length > 1 && same)}
                    onPress={() => choose(option)}
                  />
                ) : null}
              </>
            ) : (
              <Txt>Choose an available saved version.</Txt>
            )}
          </Card>
        );
      })}
      {same && options.length > 1 ? <Txt>Choose two different versions to compare.</Txt> : null}
      {!readOnly ? (
        <Field
          label="Feedback (optional)"
          value={feedback}
          onChange={setFeedback}
          multiline
          maxLength={2400}
          hint="Describe what should change. Your message stays unsent until you review it in chat."
        />
      ) : null}
    </DetailScreen>
  );
}
