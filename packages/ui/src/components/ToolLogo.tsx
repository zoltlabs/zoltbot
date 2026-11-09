import antigravity from "./tool-logos/antigravity.svg";
import claude from "./tool-logos/claude.svg";
import codex from "./tool-logos/codex.svg";
import cursor from "./tool-logos/cursor.svg";
import deepseek from "./tool-logos/deepseek.svg";
import grok from "./tool-logos/grok.svg";
import opencode from "./tool-logos/opencode.svg";
import openrouter from "./tool-logos/openrouter.svg";
import pi from "./tool-logos/pi.svg";
import "./tool-logo.css";

/* Single-color marks are drawn as a mask so they take the text color in both themes. */
const logos: Record<string, { src: string; mono?: true }> = {
  antigravity: { src: antigravity },
  claude: { src: claude },
  codex: { src: codex, mono: true },
  cursor: { src: cursor, mono: true },
  deepseek: { src: deepseek },
  grok: { src: grok, mono: true },
  opencode: { src: opencode, mono: true },
  openrouter: { src: openrouter, mono: true },
  pi: { src: pi },
};

/** The logo for an agent definition id such as "claude" or "pi:deepseek", if one is bundled. */
export function toolLogo(definitionId: string | undefined) {
  if (!definitionId) return undefined;
  return logos[definitionId] ?? logos[definitionId.split(":").at(-1) ?? ""];
}

export function ToolLogo({ tool, size }: { tool: string; size: number }) {
  const logo = toolLogo(tool);
  if (!logo) return null;
  return logo.mono ? (
    <span
      className="zb-tool-logo mono"
      style={{ width: size, height: size, maskImage: `url("${logo.src}")` }}
      aria-hidden="true"
    />
  ) : (
    <img className="zb-tool-logo" src={logo.src} width={size} height={size} alt="" />
  );
}
