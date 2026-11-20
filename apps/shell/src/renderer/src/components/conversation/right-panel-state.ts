import { createMemo, createSignal } from "solid-js";
import type { ArtifactSummary } from "../../../../shared/ipc";
import type { BotProfile } from "../../data";
import { ARTIFACT_PANEL_DEFAULT, ARTIFACT_PANEL_MAX, ARTIFACT_PANEL_MIN } from "../ArtifactPanel";
import { readPanelWidth } from "../PanelResizer";
import {
  ARTIFACT_PANEL_STORAGE_KEY,
  BROWSER_PANEL_DEFAULT,
  BROWSER_PANEL_MAX,
  BROWSER_PANEL_MIN,
  BROWSER_PANEL_STORAGE_KEY,
  type RightPanelMode,
  SETTINGS_PANEL_DEFAULT,
  SETTINGS_PANEL_MAX,
  SETTINGS_PANEL_MIN,
  SETTINGS_PANEL_STORAGE_KEY,
} from "./constants";

/** Which side panel each agent's chat has open, and the saved panel widths. */
export function createRightPanelState(props: {
  bot: BotProfile | undefined;
  agentPickerOpen: boolean;
  onSelectAgent: (botId: string) => void;
}) {
  const [rightPanels, setRightPanels] = createSignal<Record<string, RightPanelMode>>({});
  const [settingsPanelWidth, setSettingsPanelWidth] = createSignal(
    readPanelWidth(
      SETTINGS_PANEL_STORAGE_KEY,
      SETTINGS_PANEL_DEFAULT,
      SETTINGS_PANEL_MIN,
      SETTINGS_PANEL_MAX,
    ),
  );
  const [browserPanelWidth, setBrowserPanelWidth] = createSignal(
    readPanelWidth(
      BROWSER_PANEL_STORAGE_KEY,
      BROWSER_PANEL_DEFAULT,
      BROWSER_PANEL_MIN,
      BROWSER_PANEL_MAX,
    ),
  );
  const [artifactPanelWidth, setArtifactPanelWidth] = createSignal(
    readPanelWidth(
      ARTIFACT_PANEL_STORAGE_KEY,
      ARTIFACT_PANEL_DEFAULT,
      ARTIFACT_PANEL_MIN,
      ARTIFACT_PANEL_MAX,
    ),
  );
  const [openArtifacts, setOpenArtifacts] = createSignal<Record<string, ArtifactSummary>>({});
  const activeRightPanel = createMemo<RightPanelMode>(() => {
    if (props.agentPickerOpen) return "none";
    const botId = props.bot?.id;
    return botId ? (rightPanels()[botId] ?? "none") : "none";
  });
  const screenOpen = () => activeRightPanel() === "browser";
  const settingsOpen = () => activeRightPanel() === "settings";
  const organizationOpen = () => activeRightPanel() === "organization";
  const openArtifact = () => {
    const botId = props.bot?.id;
    return botId ? openArtifacts()[botId] : undefined;
  };
  const artifactOpen = () => activeRightPanel() === "artifact" && Boolean(openArtifact());

  /** Opens a chat from the Organization panel and keeps the panel open beside it. */
  function openFromOrganization(botId: string) {
    if (botId !== props.bot?.id)
      setRightPanels((current) => ({ ...current, [botId]: "organization" }));
    props.onSelectAgent(botId);
  }

  function showArtifact(artifact: ArtifactSummary) {
    const botId = props.bot?.id;
    if (!botId || !artifact.manifestHash) return;
    if (artifactOpen() && openArtifact()?.versionId === artifact.versionId) {
      setActiveRightPanel("none");
      return;
    }
    if (screenOpen()) void window.openbot.browser.setVisible({ visible: false });
    setOpenArtifacts((current) => ({ ...current, [botId]: artifact }));
    setActiveRightPanel("artifact");
  }

  function setActiveRightPanel(mode: RightPanelMode) {
    const botId = props.bot?.id;
    if (!botId) return;
    setRightPanels((current) =>
      current[botId] === mode ? current : { ...current, [botId]: mode },
    );
  }

  return {
    rightPanels,
    setRightPanels,
    settingsPanelWidth,
    setSettingsPanelWidth,
    browserPanelWidth,
    setBrowserPanelWidth,
    artifactPanelWidth,
    setArtifactPanelWidth,
    activeRightPanel,
    screenOpen,
    settingsOpen,
    organizationOpen,
    openArtifact,
    artifactOpen,
    setActiveRightPanel,
    openFromOrganization,
    showArtifact,
  };
}

export type RightPanelState = ReturnType<typeof createRightPanelState>;
