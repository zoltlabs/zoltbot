// Problems the design checks find in the app today, each with the fix that removes it. A
// problem matches when its text contains `match` on the named page ("*" for every page).
// Remove an entry in the commit that fixes it.

export interface KnownProblem {
  page: string;
  match: string;
  fix: string;
}

const COVERED_CHAT =
  "The chat stays mounted under the Tasks, Models and Map pages, so its controls are still in " +
  "the tab order behind the page. Mark `.conversation-slot` inert while a page covers it " +
  "(App.tsx), then remove these entries.";

export const KNOWN_PROBLEMS: readonly KnownProblem[] = [
  { page: "tasks", match: "can't be clicked; something covers it", fix: COVERED_CHAT },
  { page: "models", match: "can't be clicked; something covers it", fix: COVERED_CHAT },
  { page: "map", match: "can't be clicked; something covers it", fix: COVERED_CHAT },
];
