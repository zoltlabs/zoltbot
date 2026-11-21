import { createSignal } from "solid-js";

// A8: the starred model ids, shared by every model picker and saved in the daemon's settings,
// so the phone sees the same list.
const [starredIds, setStarredIds] = createSignal<string[]>([]);
/** Saves still in flight; a read while one is out could return the list before it. */
let saving = 0;
/** Bumped on each local change, so a read that started earlier doesn't undo it. */
let version = 0;

/** Reads the list again when a picker opens, to pick up the phone's changes. */
export function refreshStarredModels() {
  const read = window.openbot?.models?.starred;
  if (!read || saving > 0) return;
  const started = version;
  void read()
    .then((ids) => {
      if (version === started && saving === 0) setStarredIds(ids);
    })
    .catch(() => undefined);
}

/** Stars or unstars a model. The list changes at once; a failed save rereads the saved list. */
export function toggleStarredModel(id: string) {
  const before = starredIds();
  const next = before.includes(id) ? before.filter((item) => item !== id) : [id, ...before];
  version += 1;
  setStarredIds(next);
  const save = window.openbot?.models?.setStarred;
  if (!save) return;
  saving += 1;
  void save(next)
    .catch(() => undefined)
    .finally(() => {
      saving -= 1;
      if (saving === 0) {
        version += 1;
        refreshStarredModels();
      }
    });
}

export { starredIds };
