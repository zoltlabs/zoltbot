import { browserCapabilityErrors } from "./browser/errors.js";
/** Public capability failures that can be shown without exposing native error text. */
export const runtimeCapabilityErrors = [
  ...browserCapabilityErrors,
  "native_start_uncertain",
  "connection_revoked",
  "connection_credentials_unavailable",
  "context_budget_hold",
  "connection_native_name_conflict",
  "host_mcp_name_conflict",
  "native_skills_loading_unavailable",
  "read_only_mode_unavailable",
  "http_mcp_not_supported",
  "unsupported_model_selection",
  "unsupported_effort",
] as const;

export const runtimeOpenErrors: readonly string[] = [
  "runtime_closed",
  "runtime_session_owned",
  "runtime_input_review_required",
  "native_provider_changed",
  "native_cwd_changed",
  "runtime_private_context_required",
  "resume_identity_changed",
  "runtime_open_failed",
  "runtime_cleanup_required",
  "auth_required",
  ...runtimeCapabilityErrors,
  "runtime_configuration_changed",
  "runtime_adapter_unavailable",
  "runtime_workspace_unavailable",
  "runtime_workspace_changed",
  "injection_fixed_budget_exceeded",
  "runtime_credentials_unavailable",
  "runtime_credential_location_unsupported",
];
