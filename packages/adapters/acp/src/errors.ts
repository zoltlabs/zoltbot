/** Convert only recognized native authentication failures into the shared recovery state. */
export function acpError(error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    (error.code === -32000 || error.code === -32002) &&
    typeof error.message === "string" &&
    /authentication required|not authenticated|not logged in|unauthenticated/i.test(error.message)
  )
    return new Error("auth_required");
  return error instanceof Error ? error : new Error("provider_request_failed");
}
