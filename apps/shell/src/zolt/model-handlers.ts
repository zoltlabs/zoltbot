import { IPC_CHANNELS } from "../shared/ipc";
import type { BackupEntryView, BackupRole } from "../shared/models";
import { requireString } from "./parsers";
import type { ZoltService } from "./zolt-service";

const ROLES: BackupRole[] = ["employee", "manager", "ceo"];

function parseEntries(value: unknown): BackupEntryView[] | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 8) throw new Error("Choose up to 8 backups.");
  return value.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const model = typeof row.model === "string" && row.model ? { model: row.model } : {};
    return { accountId: requireString(row.accountId, "accountId"), ...model };
  });
}

/** The renderer's account and backup order calls. */
export function modelHandlers(service: ZoltService): Record<string, (input: unknown) => unknown> {
  return {
    [IPC_CHANNELS.modelsRead]: () => service.accounts.read(),
    [IPC_CHANNELS.modelsAddAccount]: (input) => {
      const row = (input ?? {}) as Record<string, unknown>;
      return service.accounts.addAccount({
        definitionId: requireString(row.definitionId, "definitionId"),
        label: requireString(row.label, "label"),
      });
    },
    [IPC_CHANNELS.modelsSignIn]: (id) => service.accounts.signIn(requireString(id, "accountId")),
    [IPC_CHANNELS.modelsCheck]: (id) => service.accounts.check(requireString(id, "accountId")),
    [IPC_CHANNELS.modelsRemove]: (id) => service.accounts.remove(requireString(id, "accountId")),
    [IPC_CHANNELS.modelsSetOrder]: (input) => {
      const row = (input ?? {}) as Record<string, unknown>;
      const role = ROLES.find((item) => item === row.role);
      if (!role) throw new Error("Choose employees, managers or the CEO.");
      return service.accounts.setOrder({ role, entries: parseEntries(row.entries) });
    },
  };
}
