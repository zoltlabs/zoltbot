import { PREFERENCE_CHANNELS, type Preferences } from "../../shared/preferences";

/** Where preferences are kept: the file in the app, memory in headless tests. */
export interface PreferencesStore {
  read: () => Promise<Preferences>;
  update: (patch: unknown) => Promise<Preferences>;
}

/**
 * The `preferences:get` and `preferences:set` handlers. Updates run one at a
 * time, so two quick changes can't overwrite each other, and each saved
 * result goes to `onChange` for every window to apply.
 */
export function preferenceHandlers(
  store: PreferencesStore,
  onChange: (preferences: Preferences) => void,
): Record<string, (input?: unknown) => Promise<Preferences>> {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    [PREFERENCE_CHANNELS.preferencesGet]: () => store.read(),
    [PREFERENCE_CHANNELS.preferencesSet]: (patch) => {
      const next = queue.then(() => store.update(patch));
      queue = next.catch(() => undefined);
      return next.then((preferences) => {
        onChange(preferences);
        return preferences;
      });
    },
  };
}
