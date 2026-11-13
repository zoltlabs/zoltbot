export type MacExecutionMode = "off" | "ask" | "allow_listed";
export type CloudSecretName = "anthropic" | "openai" | "github";
export interface CloudSettingsStatus {
  configured: boolean;
  online: boolean;
  account?: { userId: string; sessionId: string; orgId: string; orgName: string };
  eligible: boolean;
  enabled: boolean;
  runTasksOnMac: boolean;
  macExecution: MacExecutionMode;
  projects: Array<{ id: string; name: string; folder?: string }>;
  usage?: { sandboxSeconds: number; limitSeconds: number };
}
export interface CloudSettingsBridge {
  status(): Promise<CloudSettingsStatus>;
  signIn(): Promise<CloudSettingsStatus>;
  cancelSignIn(): Promise<void>;
  setEnabled(input: { sessionId: string; enabled: boolean }): Promise<CloudSettingsStatus>;
  setMacRunner(input: { sessionId: string; enabled: boolean }): Promise<CloudSettingsStatus>;
  setMacExecution(input: {
    sessionId: string;
    mode: MacExecutionMode;
  }): Promise<CloudSettingsStatus>;
  saveSecret(input: { sessionId: string; name: CloudSecretName; value: string }): Promise<void>;
  linkFolder(input: { sessionId: string; projectId: string }): Promise<CloudSettingsStatus>;
  onAccountChanged(listener: () => void): () => void;
}
