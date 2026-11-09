import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { writeError } from "../data/manage";
import { text } from "../data/view";
import { useAction } from "../state/actions";
import { useClient, useLink, useSnapshot } from "../state/link";
import { useTheme } from "../theme";
import { BackBar, OfflineBanner } from "../ui/chrome";
import { Group, Row, Section, Txt } from "../ui/kit";
import { pick } from "../ui/SessionControls";
import { Toggle } from "../ui/Toggle";

interface Skill {
  id: string;
  name: string;
  current_revision: number;
}
interface Assignment {
  skillId: string;
  revision: number;
}
const assignments = (profileId: string, scopeId: string) =>
  (
    useLink.getState().client?.getState().call("skill.assignments", { profileId, scopeId }) ??
    Promise.reject(new Error("Not connected to your Mac."))
  ).then((value) => ((value ?? {}) as { assignments?: Assignment[] }).assignments ?? []);

/**
 * Which library skills an agent gets in one project. Turning one on pins its current version;
 * installing and updating skills stays on the Mac.
 */
export default function Skills() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const snapshot = useSnapshot();
  const online = useClient((state) => state.status === "online");
  const { run, busy } = useAction();
  const agents = (snapshot.entities.agent ?? []).filter((row) => row.archived !== true);
  const projects = (snapshot.entities.project ?? []).filter((row) => row.archived !== true);
  const [agentId, setAgentId] = useState(text(agents[0]?.id));
  const [projectId, setProjectId] = useState(text(projects[0]?.id));
  const [skills, setSkills] = useState<Skill[]>();
  const [assigned, setAssigned] = useState<Assignment[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const client = useLink.getState().client?.getState();
    if (!client || !online) return;
    let live = true;
    void client
      .call("skill.list", {})
      .then((value) => live && setSkills(((value ?? {}) as { skills?: Skill[] }).skills ?? []))
      .catch(() => live && setError("Skills could not be loaded."));
    return () => {
      live = false;
    };
  }, [online]);
  useEffect(() => {
    if (!online || !agentId || !projectId) return;
    let live = true;
    assignments(agentId, projectId)
      .then((rows) => live && setAssigned(rows))
      .catch(() => live && setAssigned([]));
    return () => {
      live = false;
    };
  }, [online, agentId, projectId]);

  const agentName = text(agents.find((row) => row.id === agentId)?.name) || "Choose";
  const projectName = text(projects.find((row) => row.id === projectId)?.name) || "Choose";
  const change = async (skill: Skill, enabled: boolean, revision: number) => {
    setError("");
    await run(
      "skill.access",
      {
        profileId: agentId,
        scopeId: projectId,
        skillId: skill.id,
        revision,
        enabled,
        confirmed: enabled,
      },
      { quiet: true },
    ).catch((cause: unknown) => setError(writeError(cause)));
    setAssigned(await assignments(agentId, projectId).catch(() => assigned));
  };
  const toggle = (skill: Skill, on: boolean, assignment: Assignment | undefined) => {
    if (!on) return void change(skill, false, assignment?.revision ?? skill.current_revision);
    Alert.alert(
      `Turn on ${skill.name}?`,
      `${agentName} gets version ${skill.current_revision} in new chats in ${projectName}.`,
      [
        { text: "Cancel", style: "cancel" },
        { text: "Turn on", onPress: () => void change(skill, true, skill.current_revision) },
      ],
    );
  };

  const locked = !online || busy;
  return (
    <View style={[styles.page, { backgroundColor: c["bg-page"], paddingTop: insets.top + 4 }]}>
      <BackBar label="Settings" />
      <ScrollView contentContainerStyle={styles.body}>
        <Txt v="largeTitle" accessibilityRole="header">
          Skills
        </Txt>
        <OfflineBanner />
        <Group>
          <Row
            title="Agent"
            right={<Txt tone="accent">{agentName}</Txt>}
            onPress={() =>
              pick(
                "Agent",
                undefined,
                agents.map((row) => text(row.name)),
                (index) => setAgentId(text(agents[index]?.id)),
              )
            }
          />
          <Row
            title="Project"
            right={<Txt tone="accent">{projectName}</Txt>}
            onPress={() =>
              pick(
                "Project",
                undefined,
                projects.map((row) => text(row.name)),
                (index) => setProjectId(text(projects[index]?.id)),
              )
            }
            last
          />
        </Group>
        {error ? <Txt tone="danger">{error}</Txt> : null}
        <Section title="Skills" count={skills?.length} />
        {!skills ? (
          <Txt tone="muted">{online ? "Loading…" : "Skills load when your Mac is online."}</Txt>
        ) : skills.length ? (
          <Group>
            {skills.map((skill, index) => {
              const assignment = assigned.find((row) => row.skillId === skill.id);
              return (
                <Toggle
                  key={skill.id}
                  label={skill.name}
                  note={
                    assignment
                      ? assignment.revision < skill.current_revision
                        ? `Version ${assignment.revision} · ${skill.current_revision} available`
                        : `Version ${assignment.revision}`
                      : undefined
                  }
                  value={!!assignment}
                  disabled={locked || !agentId || !projectId}
                  onChange={(on) => toggle(skill, on, assignment)}
                  last={index === skills.length - 1}
                />
              );
            })}
          </Group>
        ) : (
          <Txt tone="muted">No skills yet. Add them on your Mac.</Txt>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  body: { padding: 16, gap: 12 },
});
