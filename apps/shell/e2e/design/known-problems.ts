// Problems the design checks find in the app today, each with the fix that removes it. A
// problem matches when its text contains `match` on the named page ("*" for every page).
// Remove an entry in the commit that fixes it.

export interface KnownProblem {
  page: string;
  match: string;
  fix: string;
}

export const KNOWN_PROBLEMS: readonly KnownProblem[] = [];
