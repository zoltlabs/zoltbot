# Adapter SDK

The SDK defines native adapter/session contracts, event queues, image input and
exclusive native writer leases. It imports no daemon or hosted service code.

Hosts can opt into environment-based MCP authentication with `hostMcp.tokenEnv`.
The corresponding `OpenOptions.env` entry must contain the exact in-memory host
credential. `hostMcpTokenEnvironment` checks the identifier and value before an
adapter writes configuration; missing, mismatched or invalid bindings fail with
a fixed code. The credential stays in the child environment, while provider
configuration contains only a variable name or placeholder.

This option does not change callers that use the existing header-based route.
The daemon's cloud resource host must opt in explicitly. Tests use generated
in-memory values and refuse malformed names and missing/mismatched bindings.
