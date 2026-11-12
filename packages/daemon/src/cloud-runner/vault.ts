import type { PrivateVault } from "../private-context.js";
import { isSecretReference } from "../secrets.js";

export interface TaskVaultScope {
  orgId: string;
  taskId: string;
}
/** A cloud task cannot resolve another task's or a Local session's keychain references. */
export function taskVault(base: PrivateVault, source: TaskVaultScope): PrivateVault {
  const scope = structuredClone(source);
  if (!scope.orgId || !scope.taskId) throw new Error("runner_private_context_unavailable");
  const wrap = (value: unknown) => ({ version: 1, ...scope, value });
  const read = async (reference: string) => {
    try {
      if (!isSecretReference(reference)) throw new Error();
      const envelope = await base.read(reference);
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error();
      const row = envelope as Record<string, unknown>;
      if (
        row.version !== 1 ||
        row.orgId !== scope.orgId ||
        row.taskId !== scope.taskId ||
        Object.keys(row).length !== 4 ||
        !Object.hasOwn(row, "value")
      )
        throw new Error();
      return row.value;
    } catch {
      throw new Error("runner_private_context_unavailable");
    }
  };
  return {
    async put(value) {
      try {
        const result = await base.put(wrap(value));
        if (!isSecretReference(result.reference)) throw new Error();
        return { reference: result.reference };
      } catch {
        throw new Error("runner_private_context_unavailable");
      }
    },
    read,
    ...(base.replace
      ? {
          async replace(reference: string, value: unknown) {
            await read(reference);
            try {
              await base.replace?.(reference, wrap(value));
            } catch {
              throw new Error("runner_private_context_unavailable");
            }
          },
        }
      : {}),
    ...(base.remove
      ? {
          async remove(reference: string) {
            await read(reference);
            try {
              await base.remove?.(reference);
            } catch {
              throw new Error("runner_private_context_unavailable");
            }
          },
        }
      : {}),
  };
}
