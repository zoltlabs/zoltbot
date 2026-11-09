# Design guidelines

These rules apply to all product interfaces, websites, and new or updated designs in this repository.

- Do not use eyebrows: small labels or kicker text placed above a heading.
- Use sentence case for headings. Never use all-capital heading text or apply uppercase styling to headings.
- Establish hierarchy through typography, spacing, and layout instead of eyebrows or capitalization.

## Sources of truth

Paths below are relative to this repository.

| Source | Owns |
| --- | --- |
| `packages/tokens/tokens.css` | Shared `--zb-*` primitives and semantic colors, typography, spacing and radii; dark base and light overrides |
| `packages/tokens/desktop.css` | Desktop appearance overrides, font stacks and focus tokens |
| `packages/ui/src/theme/index.css` | Desktop stylesheet entry point and import order |
| `packages/ui/src/theme/` | Font loading, base styles, controls and layout |
| `packages/ui/src/components/` | Shared UI components and `kit.css`; reuse before creating a new control |
| `apps/mobile/src/theme/index.ts` | Mobile theme API, typography roles and touch target size |
| `apps/mobile/src/theme/generate.ts` and `apps/mobile/scripts/build-theme.ts` | Generate mobile tokens from the shared CSS sources |
| `apps/mobile/src/theme/tokens.generated.ts` | Generated mobile output; regenerate rather than editing directly |
| `packages/ui/src/theme/tokens.test.ts` and `apps/mobile/src/theme/theme.test.ts` | Existing token consistency checks |

## Required design and accessibility rules

- Reuse existing shared components and semantic tokens before adding styles. Do not introduce literal colors, sizes, or radii where a semantic token exists. Add reusable values at the owning source; do not hand-edit generated token copies.
- Preserve the existing font families and type scale. Use readable weights, line heights that allow wrapping, and layouts that accommodate long labels and translated text. Do not hide necessary content behind truncation without a way to read it.
- Use native semantic controls where possible. Every control needs an accessible name, visible keyboard focus, and a keyboard path. Forms need persistent labels and errors associated with the relevant fields. Overlays must manage and restore focus.
- Meet WCAG 2.2 AA for web interfaces: text contrast of at least 4.5:1 (3:1 for qualifying large text), and 3:1 for meaningful UI boundaries and states. Measure actual foreground/background pairs; token reuse alone does not prove contrast. Do not communicate meaning through color alone.
- Respect reduced motion. Keep content usable at 200% text resize and web layouts usable at 320 CSS pixels wide. On mobile, preserve Dynamic Type support, screen-reader names and states, and the existing 44-point touch target convention.

## Design skills

Before interface work, read this file and the relevant installed skills through the current agent's skill catalog. Read each selected skill's `SKILL.md` and applicable references before applying it. These are development aids, not application runtime dependencies; do not bake machine-specific skill paths into the repository.

| Skill | Use for |
| --- | --- |
| `better-accessibility` | Every interactive UI change: semantics, keyboard, focus, forms, assistive technology, motion and zoom |
| `better-typography` | Text styles, hierarchy, wrapping, fonts and truncation |
| `better-colors` | Palette or token changes and measured contrast |
| `better-layout` | Grouping, responsive layouts, reading order and content fit |
| `better-writing` | Labels, instructions, errors and empty states |
| `better-ui` | Controls, surfaces, icons, interaction states and motion |
| `better-interface` | A requested review spanning an entire screen or flow |

Use the skills relevant to the change; a small copy edit does not need every domain review. The no-eyebrow and sentence-case rules above take precedence over optional styling recipes in skills. If a skill is unavailable, follow the rules in this file and report the missing review coverage; do not claim that skill was applied.

## Verification before completion

Inspect affected default, loading, empty, error and disabled states where applicable. Verify keyboard and focus behavior for interaction changes, contrast for changed color pairs, and wrapping/reflow for layout or typography changes. Check supported themes. Use existing targeted tests and headless browser checks; follow `AGENTS.md` for native testing authorization. Automated checks do not establish screen-reader or visual correctness by themselves. Report what was verified and any checks that remain unverified.
