import { lazy, Suspense } from "react";
import type { Row } from "../chat/types.js";
import { Button } from "../components/primitives.js";
import { AccountSettings } from "../settings/Account.js";
import { Connections } from "../settings/Connections.js";
import { Devices } from "../settings/Devices.js";
import { OrchestrationSettings } from "../settings/OrchestrationSettings.js";
import { VoiceSettings } from "../settings/Voice.js";
import { resetOnboarding } from "../setup/onboarding-state.js";
import { UpdateSettings } from "../setup/UpdateNotice.js";
import { GitHubSettings } from "../shipping/GitHubSettings.js";
import { SkillsSettings } from "../skills/SkillsSettings.js";
import { defaultFontScale, type Route, type Theme } from "../state.js";
import { BrowserSettings } from "../tasks/Browser.js";
import { RoutineConnectionReturn } from "../tasks/RoutineConnectionReturn.js";
import type { useConnection } from "../use-connection.js";

const Doctor = lazy(() => import("../setup/Doctor.js"));
const Rules = lazy(() => import("../rules/Rules.js"));
// Each section keeps its own route, so old links (#doctor, #rules) land on the right tab.
const tabs = [
  { id: "general", label: "General", route: "Settings" },
  { id: "agents", label: "Coding agents", route: "Doctor" },
  { id: "connections", label: "Connections", route: "Connections" },
  { id: "rules", label: "Approval rules", route: "Rules" },
] as const;
export type SettingsTab = (typeof tabs)[number]["id"];

export function SettingsPage({
  tab,
  connection,
  settings,
  devices,
  fontScale,
  setFontScale,
  theme,
  setTheme,
  navigate,
}: {
  tab: SettingsTab;
  connection: ReturnType<typeof useConnection>;
  settings: Row[];
  devices: Row[];
  fontScale: number;
  setFontScale(scale: number): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  navigate(route: Route): void;
}) {
  return (
    <div className="page-stack settings-page">
      <header className="settings-heading">
        <h1>Settings</h1>
        <nav className="settings-switcher" aria-label="Settings sections">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={tab === entry.id ? "on" : undefined}
              aria-current={tab === entry.id ? "page" : undefined}
              onClick={() => navigate(entry.route)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </header>
      {tab === "agents" ? (
        <>
          <Suspense fallback={<p>Loading coding agents…</p>}>
            <Doctor connection={connection} onSetup={() => navigate("Setup")} />
          </Suspense>
          <OrchestrationSettings connection={connection} />
          <SkillsSettings connection={connection} />
          <BrowserSettings connection={connection} />
        </>
      ) : tab === "connections" ? (
        <>
          <RoutineConnectionReturn connection={connection} />
          <Connections
            call={connection.call}
            projects={connection.snapshot.entities.project ?? []}
            profiles={connection.snapshot.entities.agent ?? []}
            online={connection.status === "online"}
          />
          <GitHubSettings connection={connection} />
        </>
      ) : tab === "rules" ? (
        <Suspense fallback={<p>Loading approval rules…</p>}>
          <Rules connection={connection} />
        </Suspense>
      ) : (
        <GeneralSettings
          connection={connection}
          settings={settings}
          devices={devices}
          fontScale={fontScale}
          setFontScale={setFontScale}
          theme={theme}
          setTheme={setTheme}
          navigate={navigate}
        />
      )}
    </div>
  );
}

function GeneralSettings({
  connection,
  settings,
  devices,
  fontScale,
  setFontScale,
  theme,
  setTheme,
  navigate,
}: {
  connection: ReturnType<typeof useConnection>;
  settings: Row[];
  devices: Row[];
  fontScale: number;
  setFontScale(scale: number): void;
  theme: Theme;
  setTheme(theme: Theme): void;
  navigate(route: Route): void;
}) {
  return (
    <>
      <AccountSettings />
      <section className="zb-card settings-panel">
        <h2>Appearance</h2>
        <fieldset className="theme-options">
          <legend>Theme</legend>
          {(["light", "dark", "system"] as const).map((value) => (
            <label key={value} className={`theme-option${theme === value ? " selected" : ""}`}>
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => setTheme(value)}
              />
              <span>
                {value[0]?.toUpperCase()}
                {value.slice(1)}
              </span>
            </label>
          ))}
        </fieldset>
        <label className="c">
          <span>Font size: {fontScale}%</span>
          <input
            type="range"
            min={100}
            max={150}
            step={5}
            value={fontScale}
            onChange={(event) => setFontScale(Number(event.target.value))}
          />
        </label>
        <div>
          <Button onClick={() => setFontScale(defaultFontScale)}>Reset font size</Button>
        </div>
        <UpdateSettings connection={connection} settings={settings} />
      </section>
      <section className="zb-card settings-panel">
        <h2>Onboarding</h2>
        <p className="settings-hint">
          Walk through setup again from the beginning. Your chats, projects, and connected agents
          are kept.
        </p>
        <div>
          <Button
            onClick={() => {
              resetOnboarding();
              navigate("Setup");
            }}
          >
            Restart onboarding
          </Button>
        </div>
      </section>
      <VoiceSettings />
      <Devices
        call={connection.call}
        devices={devices}
        relayUrl={String(settings.find((setting) => setting.key === "link.relayUrl")?.value ?? "")}
        online={connection.status === "online"}
      />
    </>
  );
}
