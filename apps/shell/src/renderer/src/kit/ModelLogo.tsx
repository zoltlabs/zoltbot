import claude from "./logos/claude.svg";
import deepseek from "./logos/deepseek.svg";
import grok from "./logos/grok.svg";
import openai from "./logos/openai.svg";
import openrouter from "./logos/openrouter.svg";

/* Single-color marks are drawn as a mask so they take the text color in both themes. */
const LOGOS: Record<string, { src: string; mono?: true }> = {
  claude: { src: claude },
  openai: { src: openai, mono: true },
  deepseek: { src: deepseek },
  grok: { src: grok, mono: true },
  openrouter: { src: openrouter, mono: true },
};

const MODEL_FAMILIES: [RegExp, string][] = [
  [/claude|sonnet|opus|haiku|anthropic/i, "claude"],
  [/\bgpt|chatgpt|openai|codex|\bo\d\b/i, "openai"],
  [/deepseek/i, "deepseek"],
  [/grok|xai/i, "grok"],
];

const PROVIDERS: Record<string, string> = {
  claude: "claude",
  anthropic: "claude",
  codex: "openai",
  openai: "openai",
  openrouter: "openrouter",
};

/** Which bundled logo fits a model: by its name first, then by its provider. */
export function modelLogoKey(model: { id?: string; name?: string; provider?: string }) {
  const text = `${model.name ?? ""} ${model.id ?? ""}`;
  for (const [pattern, key] of MODEL_FAMILIES) if (pattern.test(text)) return key;
  const provider = model.provider?.split(":").at(-1) ?? "";
  return PROVIDERS[provider] ?? (LOGOS[provider] ? provider : undefined);
}

/** The model maker's logo, or nothing when none is bundled. Decorative: the name sits next to it. */
export function ModelLogo(props: {
  model: { id?: string; name?: string; provider?: string };
  size?: number;
}) {
  const logo = () => {
    const key = modelLogoKey(props.model);
    return key ? LOGOS[key] : undefined;
  };
  const size = () => `${props.size ?? 16}px`;
  return (
    <>
      {logo()?.mono ? (
        <span
          class="zb-kit-logo mono"
          style={{ width: size(), height: size(), "mask-image": `url("${logo()?.src}")` }}
          aria-hidden="true"
        />
      ) : logo() ? (
        <img
          class="zb-kit-logo"
          src={logo()?.src}
          width={props.size ?? 16}
          height={props.size ?? 16}
          alt=""
        />
      ) : null}
    </>
  );
}
