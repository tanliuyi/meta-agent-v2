import { describe, expect, it } from "vitest";
import { getMemoryEntryToolbarState } from "../src/renderer/src/features/settings/memory-entry-toolbar.tsx";

function createEditor(activeNames: readonly string[], canUndo: boolean, canRedo: boolean) {
  return {
    can() {
      return {
        redo: () => canRedo,
        undo: () => canUndo,
      };
    },
    isActive(name: string) {
      return activeNames.includes(name);
    },
  };
}

describe("getMemoryEntryToolbarState", () => {
  it("keeps undo and redo availability separate from selection formatting", () => {
    expect(getMemoryEntryToolbarState(createEditor(["bold", "orderedList"], true, false))).toEqual({
      canRedo: false,
      canUndo: true,
      isBlockquote: false,
      isBold: true,
      isBulletList: false,
      isHeading: false,
      isItalic: false,
      isLink: false,
      isOrderedList: true,
    });
  });

  it("returns the disabled state until Tiptap initializes", () => {
    expect(getMemoryEntryToolbarState(null)).toEqual({
      canRedo: false,
      canUndo: false,
      isBlockquote: false,
      isBold: false,
      isBulletList: false,
      isHeading: false,
      isItalic: false,
      isLink: false,
      isOrderedList: false,
    });
  });
});
