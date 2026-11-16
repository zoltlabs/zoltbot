import { describe, expect, it } from "vitest";
import { sessionRecovery } from "./session-recovery.js";

describe("session recovery", () => {
  it("never offers a restart when execution or protected context needs review", () => {
    for (const reason of [
      "native_start_uncertain",
      "runtime_cleanup_required",
      "runtime_private_context_required",
      "native_configuration_changed",
      "delivery_uncertain",
      "interrupt_delivery_uncertain",
      "interaction_delivery_uncertain",
    ]) {
      const recovery = sessionRecovery(reason);
      expect(recovery.reconnect).not.toBe(true);
      expect(recovery.route).toBe("Doctor");
      expect(recovery.label).toBeTruthy();
    }
  });
  it("routes model failures to model defaults instead of retrying unsupported configuration", () => {
    for (const reason of ["unsupported_model_selection", "unsupported_effort"]) {
      expect(sessionRecovery(reason)).toMatchObject({
        route: "ModelsSettings",
        label: "Choose model defaults",
      });
      expect(sessionRecovery(reason).reconnect).not.toBe(true);
    }
  });
  it("requires reviewing revoked credentials before starting another chat", () => {
    for (const reason of ["connection_revoked", "connection_credentials_unavailable"]) {
      expect(sessionRecovery(reason).route).toBe("Connections");
      expect(sessionRecovery(reason).reconnect).not.toBe(true);
    }
  });
  it("allows explicit reconnect for ordinary interruption and sign-in", () => {
    expect(sessionRecovery("daemon_restart").reconnect).toBe(true);
    expect(sessionRecovery("auth_required").reconnect).toBe(true);
  });
});
