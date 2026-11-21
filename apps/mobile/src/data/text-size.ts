// P6: the owner's text size, on top of Dynamic Type. Pure, so the steps and scaling are testable.

/** The slider's notches; 1 is the design's own size. */
export const textSizes = [0.85, 1, 1.15, 1.3, 1.5] as const;
export type TextSize = (typeof textSizes)[number];

export const textSizeLabel = (size: number) => `${Math.round(size * 100)}%`;

/** A stored value, or the default when it is missing or not one of the notches. */
export function readTextSize(raw: string | null | undefined): TextSize {
  const value = Number(raw);
  return textSizes.find((size) => size === value) ?? 1;
}

/** The nearest notch to a point along the slider, from 0 to 1. */
export function nearestTextSize(fraction: number): TextSize {
  const index = Math.round(Math.max(0, Math.min(1, fraction)) * (textSizes.length - 1));
  return textSizes[index] ?? 1;
}

/** A text style with its size and line height multiplied; the rest is unchanged. */
export function scaleText<T extends object>(style: T, size: number): T {
  if (size === 1) return style;
  const { fontSize, lineHeight } = style as { fontSize?: unknown; lineHeight?: unknown };
  return {
    ...style,
    ...(typeof fontSize === "number" ? { fontSize: Math.round(fontSize * size) } : {}),
    ...(typeof lineHeight === "number" ? { lineHeight: Math.round(lineHeight * size) } : {}),
  };
}
