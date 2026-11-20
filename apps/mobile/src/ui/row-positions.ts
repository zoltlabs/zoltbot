// C4: where each transcript row sits, so a pinned message can be scrolled to and focused. A row
// inside an agent turn is measured within the turn, then added to the turn's own position.
import { type ComponentRef, type RefObject, useRef } from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  type LayoutChangeEvent,
  type ScrollView,
  type View,
} from "react-native";

type Node = ComponentRef<typeof View>;

export interface RowTracker {
  onLayout: (event: LayoutChangeEvent) => void;
  ref: (node: Node | null) => void;
}

export function useRowPositions() {
  const blocks = useRef(new Map<string, number>());
  const inner = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, Node>());
  const node = (rowId: string) => (value: Node | null) => {
    if (value) nodes.current.set(rowId, value);
    else nodes.current.delete(rowId);
  };
  return {
    /** For a block in the transcript's list: a single row, or a turn holding these rows. */
    block: (ids: string[]) => (event: LayoutChangeEvent) => {
      for (const id of ids) blocks.current.set(id, event.nativeEvent.layout.y);
    },
    node,
    /** For a row inside a turn. */
    row: (rowId: string): RowTracker => ({
      onLayout: (event) => inner.current.set(rowId, event.nativeEvent.layout.y),
      ref: node(rowId),
    }),
    /** Scrolls to the row and moves VoiceOver there. False when the row isn't on screen. */
    async jump(
      rowId: string,
      scroll: RefObject<ComponentRef<typeof ScrollView> | null>,
    ): Promise<boolean> {
      const top = blocks.current.get(rowId);
      if (top === undefined) return false;
      const y = top + (inner.current.get(rowId) ?? 0);
      const still = await AccessibilityInfo.isReduceMotionEnabled().catch(() => false);
      scroll.current?.scrollTo({ y: Math.max(0, y - 8), animated: !still });
      const target = nodes.current.get(rowId);
      const handle = target ? findNodeHandle(target) : null;
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
      return true;
    },
  };
}
