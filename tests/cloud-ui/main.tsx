import { createRoot } from "react-dom/client";
import { CloudSettings } from "../../packages/ui/src/cloud-settings/CloudSettings.js";
import type {
  CloudSettingsBridge,
  CloudSettingsStatus,
} from "../../packages/ui/src/cloud-settings/types.js";
import "../../packages/ui/src/theme/index.css";
import "../../packages/ui/src/shell/shell-details.css";

const parameters = new URLSearchParams(location.search);
document.documentElement.dataset.theme = parameters.get("theme") ?? "dark";
let status: CloudSettingsStatus = {
  configured: true,
  online: true,
  account: {
    userId: "member",
    sessionId: "session-one",
    orgId: "personal",
    orgName: "Personal organization",
  },
  eligible: true,
  enabled: true,
  runTasksOnMac: false,
  macExecution: "ask",
  projects: [
    {
      id: "project",
      name: "A cloud project",
      folder: "/Users/you/Projects/a-project-with-a-long-directory-name-for-layout-checks",
    },
  ],
  usage: { sandboxSeconds: 5400, limitSeconds: 360000 },
};
if (parameters.has("signedOut")) delete status.account;
if (parameters.has("notEligible")) status.eligible = false;
if (parameters.has("offline")) status.online = false;
if (parameters.has("unconfigured")) status.configured = false;
if (parameters.has("disabled")) status.enabled = false;
let failStatus = parameters.has("error"),
  failSave = false,
  resolveSave: (() => void) | undefined;
const listeners = new Set<() => void>(),
  calls: Array<{
    method: string;
    sessionId?: string;
    name?: string;
    length?: number;
    enabled?: boolean;
    mode?: string;
  }> = [];
const response = () => structuredClone(status);
const bridge: CloudSettingsBridge = {
  async status() {
    if (failStatus) throw new Error("fixture_offline");
    return response();
  },
  async signIn() {
    status = {
      ...status,
      account: {
        userId: "member",
        sessionId: "session-one",
        orgId: "personal",
        orgName: "Personal organization",
      },
    };
    return response();
  },
  async cancelSignIn() {},
  async setEnabled(input) {
    calls.push({ method: "enabled", ...input });
    status.enabled = input.enabled;
    return response();
  },
  async setMacRunner(input) {
    calls.push({ method: "runner", ...input });
    status.runTasksOnMac = input.enabled;
    return response();
  },
  async setMacExecution(input) {
    calls.push({ method: "mode", ...input });
    status.macExecution = input.mode;
    return response();
  },
  async linkFolder(input) {
    calls.push({ method: "folder", sessionId: input.sessionId });
    return response();
  },
  async saveSecret(input) {
    calls.push({
      method: "secret",
      name: input.name,
      sessionId: input.sessionId,
      length: input.value.length,
    });
    if (failSave) throw new Error("fixture_save_refused");
    if (parameters.has("slowSave"))
      await new Promise<void>((resolve) => {
        resolveSave = resolve;
      });
  },
  onAccountChanged(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
declare global {
  interface Window {
    cloudFixture: {
      calls: typeof calls;
      failStatus(value: boolean): void;
      failSave(value: boolean): void;
      finishSave(): void;
      switchAccount(): void;
    };
  }
}
window.cloudFixture = {
  calls,
  failStatus(value) {
    failStatus = value;
  },
  failSave(value) {
    failSave = value;
  },
  finishSave() {
    resolveSave?.();
  },
  switchAccount() {
    status = {
      ...status,
      account: {
        userId: "another",
        sessionId: "session-two",
        orgId: "another-org",
        orgName: "Another organization",
      },
    };
    for (const listener of listeners) listener();
  },
};
const root = document.getElementById("root");
if (!root) throw new Error("fixture_root_missing");
createRoot(root).render(
  <CloudSettings bridge={bridge} onAccountSettings={() => calls.push({ method: "account" })} />,
);
