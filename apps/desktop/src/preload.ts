import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("zoltDesktop", {
  platform: process.platform,
  account: {
    status: () => ipcRenderer.invoke("zolt:account-status"),
    signIn: () => ipcRenderer.invoke("zolt:account-signIn"),
    signOut: () => ipcRenderer.invoke("zolt:account-signOut"),
    cancel: () => ipcRenderer.invoke("zolt:account-cancel"),
    revoke: (id: string) => ipcRenderer.invoke("zolt:account-revoke", id),
    revokeAll: () => ipcRenderer.invoke("zolt:account-revokeAll"),
    export: () => ipcRenderer.invoke("zolt:account-export"),
    findArtifact: (hash: string, title: string) =>
      ipcRenderer.invoke("zolt:account-find-artifact", hash, title),
    setArtifactVisibility: (input: {
      id: string;
      hash: string;
      title: string;
      visibility: "private" | "public";
      confirm: true;
    }) => ipcRenderer.invoke("zolt:account-artifact-visibility", input),
    copyArtifactLink: (id: string) => ipcRenderer.invoke("zolt:account-copy-artifact-link", id),
    uploadArtifact: (input: { hash: string; title: string; orgId: string; confirm: true }) =>
      ipcRenderer.invoke("zolt:account-upload-artifact", input),
  },
  pickViewFolder: () => ipcRenderer.invoke("zolt:view-pick-folder"),
  showViewFolder: (input: { id: string; source: "builtin" | "user" }) =>
    ipcRenderer.invoke("zolt:view-show-folder", input),
  prepareView: (hash: string) => ipcRenderer.invoke("zolt:view-prepare", hash),
  prepareArtifact: (hash: string) => ipcRenderer.invoke("zolt:artifact-prepare", hash),
  browserEvidence: (id: string) => ipcRenderer.invoke("zolt:browser-evidence", id),
  pickFolders: () => ipcRenderer.invoke("zolt:pick-folders"),
  filePath: (file: File) => webUtils.getPathForFile(file),
  openExternal: (url: string) => ipcRenderer.invoke("zolt:open-external", url),
  visibleThread: (id?: string) => ipcRenderer.send("zolt:visible-thread", id),
  connection: () => ipcRenderer.invoke("zolt:connection"),
  onConnectionChanged: (listener: () => void) => {
    const notify = () => listener();
    ipcRenderer.on("zolt:connection-changed", notify);
    return () => ipcRenderer.removeListener("zolt:connection-changed", notify);
  },
  dictation: {
    status: (params?: { locale?: string }) => ipcRenderer.invoke("zolt:dictation-status", params),
    requestPermission: (params?: { locale?: string }) =>
      ipcRenderer.invoke("zolt:dictation-request-permission", params),
    start: (options?: {
      locale?: string;
      onDevice?: boolean;
      source?: "pcm16le" | "microphone";
      contextualStrings?: string[];
    }) => ipcRenderer.invoke("zolt:dictation-start", options),
    writeAudio: (sessionId: string, pcm16le: Uint8Array) =>
      ipcRenderer.send("zolt:dictation-audio", sessionId, pcm16le),
    stop: (sessionId: string) => ipcRenderer.invoke("zolt:dictation-stop", sessionId),
    cancel: (sessionId?: string) => ipcRenderer.invoke("zolt:dictation-cancel", sessionId),
    onEvent: (listener: (event: Record<string, unknown>) => void) => {
      const notify = (_event: unknown, payload: Record<string, unknown>) => listener(payload);
      ipcRenderer.on("zolt:dictation-event", notify);
      return () => ipcRenderer.removeListener("zolt:dictation-event", notify);
    },
  },
});
