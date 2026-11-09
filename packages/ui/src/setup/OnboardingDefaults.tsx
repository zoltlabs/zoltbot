import type { PermissionProfile } from "@zoltbot/protocol";
import type { ChatConnection } from "../chat/types.js";
import { Chip } from "../components/primitives.js";
import { Devices } from "../settings/Devices.js";

const approvals: [PermissionProfile, string, string][] = [
  [
    "workspace_write",
    "Edit freely inside the project",
    "Agents edit files and run safe commands in the project. Anything outside it asks first.",
  ],
  ["full_access", "Full access", "No approvals. Best for sandboxes and throwaway repositories."],
  ["read_only", "Read only", "Agents read and suggest. Some coding tools do not offer this mode."],
];
export function OnboardingDefaults({
  connection,
  approval,
  setApproval,
  phone,
  setPhone,
  offline,
  failed,
  error,
}: {
  connection: ChatConnection;
  approval: PermissionProfile;
  setApproval(value: PermissionProfile): void;
  phone: boolean;
  setPhone(value: boolean): void;
  offline: boolean;
  failed: boolean;
  error: unknown;
}) {
  const entities = connection.snapshot.entities;
  const settings = entities.settings ?? [];
  return (
    <>
      <fieldset className="onb-choices">
        <legend className="onb-label">Approvals</legend>
        {approvals.map(([value, title, text]) => (
          <label key={value} className="onb-choice">
            <input
              type="radio"
              name="onboarding-approval"
              checked={approval === value}
              onChange={() => setApproval(value)}
            />
            <span>
              <b>
                {title}{" "}
                {value === "workspace_write" ? <Chip tone="accent">Recommended</Chip> : null}
              </b>
              <span className="onb-meta">{text}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <section className="card onb-card" aria-label="Phone">
        <label className="onb-row onb-toggle">
          <span className="onb-main">
            <span className="onb-name">Answer from my phone</span>
            <span className="onb-meta">
              Pair the Zoltbot app with a code. You can also do this later in Settings.
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={phone}
            checked={phone}
            onChange={(event) => setPhone(event.target.checked)}
          />
        </label>
        {phone ? (
          <Devices
            call={connection.call}
            devices={entities.device ?? []}
            relayUrl={String(
              settings.find((setting) => setting.key === "link.relayUrl")?.value ?? "",
            )}
            online={!offline}
          />
        ) : null}
      </section>
      {failed ? (
        <p role="alert" className="doctor-error">
          {error instanceof Error &&
          error.message.includes("definition_private_configuration_required")
            ? "A coding tool needs protected credential configuration first. No credential was copied."
            : "Setup could not be finished. Anything already saved is kept. Try again."}
        </p>
      ) : null}
    </>
  );
}
