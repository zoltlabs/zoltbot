import { readFile } from "node:fs/promises";
import type { AuthMethod, SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  AgentEvent,
  Capabilities,
  InteractionAnswer,
  InteractionDraft,
} from "@zoltbot/protocol";

export interface AcpFlavor {
  id: string;
  nativeFork?: { route: "standard" | "grok"; versions: string[] };
  testedVersions: string;
  newSession?(): AcpFlavor;
  readOnlyModes?: string[];
  approvalCapability?: Capabilities["approvals"];
  nativeVisibility?: Capabilities["nativeSessions"]["visibleInOfficialApps"];
  interactionCapabilities?: Pick<Capabilities, "questions" | "planReview" | "questionFeatures">;
  clientInfo?: { name: string; version: string };
  chooseAuth?(
    methods: AuthMethod[],
    env: Record<string, string>,
  ): { methodId: string; meta?: Record<string, unknown> } | undefined;
  extraInitMeta?: Record<string, unknown>;
  sessionNotFound?(error: unknown): boolean;
  cancelBehavior?: "standard" | "cancel_then_resume";
  promptStaysOpenForBackground?: boolean;
  mapExtensionRequest?(method: string, params: unknown): InteractionDraft | undefined;
  mapExtensionAnswer?(
    method: string,
    params: unknown,
    answer: InteractionAnswer | undefined,
  ): unknown;
  mapExtensionNotification?(method: string, params: unknown): AgentEvent[];
  mapUpdate?(update: SessionUpdate): AgentEvent[];
  mcpInjection: "session_new" | "config_file";
  instructionInjection: "first_block" | "refresh_every_n_prompts" | "none";
  refreshEvery?: number;
}
export const genericFlavor: AcpFlavor = {
  id: "generic",
  testedVersions: "ACP v1",
  mcpInjection: "session_new",
  instructionInjection: "first_block",
};

export class FlavorRegistry {
  private readonly flavors = new Map<string, AcpFlavor>([[genericFlavor.id, genericFlavor]]);
  register(flavor: AcpFlavor) {
    if (!flavor.id || this.flavors.has(flavor.id)) throw new Error("duplicate_or_invalid_flavor");
    if (
      flavor.instructionInjection === "refresh_every_n_prompts" &&
      (!Number.isInteger(flavor.refreshEvery) || (flavor.refreshEvery ?? 0) < 1)
    )
      throw new Error("invalid_instruction_refresh");
    this.flavors.set(flavor.id, flavor);
  }
  get(id = "generic") {
    const flavor = this.flavors.get(id);
    if (!flavor) throw new Error("unknown_acp_flavor");
    return flavor;
  }
  async load(fileUrl: string) {
    this.register(parseFlavorConfig(JSON.parse(await readFile(new URL(fileUrl), "utf8"))));
  }
}
export function parseFlavorConfig(value: unknown): AcpFlavor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_flavor_file");
  const config = value as Record<string, unknown>;
  const keys = new Set([
    "id",
    "testedVersions",
    "mcpInjection",
    "instructionInjection",
    "refreshEvery",
    "cancelBehavior",
    "promptStaysOpenForBackground",
    "approvalCapability",
    "nativeVisibility",
    "readOnlyModes",
  ]);
  if (
    Object.keys(config).some((k) => !keys.has(k)) ||
    typeof config.id !== "string" ||
    typeof config.testedVersions !== "string" ||
    !["session_new", "config_file"].includes(String(config.mcpInjection)) ||
    !["first_block", "refresh_every_n_prompts", "none"].includes(
      String(config.instructionInjection),
    ) ||
    (config.cancelBehavior !== undefined &&
      !["standard", "cancel_then_resume"].includes(String(config.cancelBehavior))) ||
    (config.readOnlyModes !== undefined &&
      (!Array.isArray(config.readOnlyModes) ||
        !config.readOnlyModes.length ||
        config.readOnlyModes.some((mode) => typeof mode !== "string" || !mode))) ||
    (config.approvalCapability !== undefined &&
      !["granular", "coarse", "none"].includes(String(config.approvalCapability))) ||
    (config.nativeVisibility !== undefined &&
      !["yes", "no", "unknown"].includes(String(config.nativeVisibility))) ||
    (config.promptStaysOpenForBackground !== undefined &&
      typeof config.promptStaysOpenForBackground !== "boolean")
  )
    throw new Error("invalid_flavor_file");
  return config as unknown as AcpFlavor;
}
