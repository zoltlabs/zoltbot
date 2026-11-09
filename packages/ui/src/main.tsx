import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./shell/App.js";
import { holdSelectWidths } from "./theme/select-fit.js";
import { trackUsableShell } from "./usable-shell.js";
import "./shell/shell.css";
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const root = document.getElementById("root");
if (!root) throw new Error("Root element missing");
trackUsableShell(root);
holdSelectWidths(root);
// The desktop window has no system title bar on macOS; shell.css lays out around the traffic lights.
if (window.zoltDesktop?.platform === "darwin") document.documentElement.dataset.titlebar = "inset";
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
