import cline from "../../flavors/cline.json" with { type: "json" };
import copilot from "../../flavors/copilot.json" with { type: "json" };
import goose from "../../flavors/goose.json" with { type: "json" };
import grok from "../../flavors/grok.json" with { type: "json" };
import kimi from "../../flavors/kimi.json" with { type: "json" };
import opencode from "../../flavors/opencode.json" with { type: "json" };
import qwen from "../../flavors/qwen.json" with { type: "json" };
import vibe from "../../flavors/vibe.json" with { type: "json" };
import { FlavorRegistry, parseFlavorConfig } from "../flavor.js";
import { antigravityFlavor } from "./antigravity.js";
import { cursorFlavor } from "./cursor.js";
import { geminiFlavor } from "./gemini.js";

export { cursorFlavor } from "./cursor.js";
export function builtinRegistry() {
  const registry = new FlavorRegistry();
  registry.register(cursorFlavor());
  registry.register(antigravityFlavor());
  registry.register(geminiFlavor());
  registry.register(parseFlavorConfig(opencode));
  registry.register({
    ...parseFlavorConfig(grok),
    nativeFork: { route: "grok", versions: [] },
    chooseAuth(methods, env) {
      const methodId =
        env.XAI_API_KEY && methods.some((method) => method.id === "xai.api_key")
          ? "xai.api_key"
          : methods.some((method) => method.id === "cached_token")
            ? "cached_token"
            : undefined;
      return methodId ? { methodId, meta: { headless: true } } : undefined;
    },
  });
  for (const config of [cline, goose, qwen, kimi, copilot, vibe])
    registry.register(parseFlavorConfig(config));
  return registry;
}
