const key = "zoltbot.onboarding.v1";

export function needsOnboarding(): boolean {
  try {
    return localStorage.getItem(key) !== "done";
  } catch {
    return true;
  }
}

export function completeOnboarding(): void {
  try {
    localStorage.setItem(key, "done");
  } catch {}
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(key);
  } catch {}
}
