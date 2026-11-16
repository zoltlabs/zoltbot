import type { Route } from "../state.js";

export type Recovery = {
  title: string;
  description: string;
  route?: Route;
  label?: string;
  reconnect?: boolean;
};
/** A recorded failure decides the recovery; never retry uncertain execution automatically. */
export function sessionRecovery(reason: string): Recovery {
  switch (reason) {
    case "runtime_cleanup_required":
      return {
        title: "Previous process needs review",
        description: "Check that the coding tool has stopped before opening another session.",
        route: "Doctor",
        label: "Check coding agent",
      };
    case "delivery_uncertain":
    case "interrupt_delivery_uncertain":
    case "interaction_delivery_uncertain":
      return {
        title: "Check the coding tool before continuing",
        description:
          "Delivery could not be confirmed. Check the native session before retrying a message or approval.",
        route: "Doctor",
        label: "Check coding agent",
      };
    case "native_start_uncertain":
      return {
        title: "Startup could not be confirmed",
        description:
          "Check the coding tool’s session list before reconnecting to avoid starting a duplicate.",
        route: "Doctor",
        label: "Check coding agent",
      };
    case "auth_required":
      return {
        title: "Sign in to continue",
        description: "Sign in to your coding tool, then reconnect.",
        reconnect: true,
      };
    case "connection_revoked":
    case "connection_credentials_unavailable":
      return {
        title: "App connection needs attention",
        description: "Review access and sign in again before starting a new chat.",
        route: "Connections",
        label: "Review connections",
      };
    case "unsupported_model_selection":
    case "unsupported_effort":
      return {
        title: "Model settings unavailable",
        description:
          "Choose a supported model and effort in workspace defaults, then start a new chat.",
        route: "ModelsSettings",
        label: "Choose model defaults",
      };
    case "binary_not_found":
    case "binary_broken":
    case "http_mcp_not_supported":
      return {
        title: "Coding agent needs setup",
        description: "Check the installation, update the coding tool, then reconnect.",
        route: "Doctor",
        label: "Check coding agent",
        reconnect: true,
      };
    case "read_only_mode_unavailable":
      return {
        title: "Read-only mode unavailable",
        description: "Start a new chat with a coding agent that supports read-only mode.",
        route: "Doctor",
        label: "Review coding agents",
      };
    case "context_budget_hold":
    case "injection_budget_exceeded":
    case "injection_fixed_budget_exceeded":
      return {
        title: "Too much added context",
        description:
          "Reduce this chat’s instructions, knowledge, skills or app access before reconnecting.",
        route: "SkillsSettings",
        label: "Review skills",
      };
    case "connection_native_name_conflict":
    case "host_mcp_name_conflict":
      return {
        title: "MCP names conflict",
        description:
          "Rename the conflicting server in the coding tool’s MCP configuration, then reconnect.",
        route: "Connections",
        label: "Review connections",
      };
    case "native_skills_loading_unavailable":
      return {
        title: "Skills unavailable for this agent",
        description: "Remove unsupported skills or choose another coding agent for a new chat.",
        route: "SkillsSettings",
        label: "Review skills",
      };
    case "runtime_workspace_choice_required":
      return {
        title: "Choose a code folder",
        description: "Select one code folder in this workspace before connecting.",
        route: "Projects",
        label: "Open workspaces",
      };
    case "runtime_workspace_unavailable":
      return {
        title: "Code folder unavailable",
        description: "Restore the original code folder before reconnecting.",
        route: "Projects",
        label: "Open workspaces",
      };
    case "native_configuration_changed":
      return {
        title: "Agent configuration changed",
        description: "Restore the original provider folder before resuming this chat.",
        route: "Doctor",
        label: "Review coding agent",
      };
    case "runtime_private_context_required":
      return {
        title: "Private context unavailable",
        description: "Restore this session’s protected context before reconnecting.",
        route: "Doctor",
        label: "Review coding agent",
      };
    default:
      return {
        title: "Coding agent disconnected",
        description: "Reconnect to continue this chat.",
        reconnect: true,
      };
  }
}
