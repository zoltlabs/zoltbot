import { type RefObject, useEffect, useId, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const requests = new Map<string, { expanded: boolean; visible: boolean; focused: boolean }>();
let granted = new Set<string>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function schedule() {
  let inline = 0,
    expanded = 0;
  const hasExpanded = [...requests.values()].some(
    (request) => request.expanded && (request.visible || request.focused),
  );
  granted = new Set(
    [...requests]
      .sort((a, b) => Number(b[1].focused) - Number(a[1].focused))
      .filter(([, request]) => {
        if (!request.visible && !request.focused) return false;
        if (hasExpanded && !request.expanded) return false;
        return request.expanded ? expanded++ < 1 : inline++ < 2;
      })
      .map(([id]) => id),
  );
  notify();
}

export function usePreviewSlot(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  expanded = false,
) {
  const id = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node || !active) return;
    let visible = false;
    const update = () => {
      requests.set(id, { expanded, visible, focused: node.contains(document.activeElement) });
      schedule();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      update();
    });
    observer.observe(node);
    node.addEventListener("focusin", update);
    node.addEventListener("focusout", update);
    // Focusing an iframe changes document.activeElement without bubbling focusin.
    window.addEventListener("blur", update);
    update();
    return () => {
      observer.disconnect();
      node.removeEventListener("focusin", update);
      node.removeEventListener("focusout", update);
      window.removeEventListener("blur", update);
      requests.delete(id);
      schedule();
    };
  }, [id, ref, active, expanded]);
  return useSyncExternalStore(
    subscribe,
    () => granted.has(id),
    () => false,
  );
}

const preferenceKey = "zoltbot.inline-artifacts";
const preferenceListeners = new Set<() => void>();
const readPreference = () => {
  try {
    return localStorage.getItem(preferenceKey) !== "disabled";
  } catch {
    return true;
  }
};
export function useInlinePreviews() {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener);
      window.addEventListener("storage", listener);
      return () => {
        preferenceListeners.delete(listener);
        window.removeEventListener("storage", listener);
      };
    },
    readPreference,
    () => false,
  );
}
export function setInlinePreviews(enabled: boolean) {
  try {
    localStorage.setItem(preferenceKey, enabled ? "enabled" : "disabled");
  } catch {
    return;
  }
  for (const listener of preferenceListeners) listener();
}
