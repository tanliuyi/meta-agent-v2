import { describe, expect, it } from "vitest";
import {
  calculateCompositionShift,
  findVisualCursor,
} from "../src/renderer/src/components/panel/terminal/terminal-composition.ts";

type CellSpec = boolean | { inverse: boolean; width: number };

function createBuffer(lines: CellSpec[][], viewportY = 0) {
  return {
    viewportY,
    getLine(row: number) {
      const cells = lines[row - viewportY];
      if (!cells) return undefined;
      return {
        length: cells.length,
        getCell(column: number) {
          const spec = cells[column];
          if (spec === undefined) return undefined;
          const inverse = typeof spec === "boolean" ? spec : spec.inverse;
          const width = typeof spec === "boolean" ? 1 : spec.width;
          return {
            getWidth: () => width,
            isInverse: () => (inverse ? 1 : 0),
          };
        },
      };
    },
  };
}

describe("terminal IME composition positioning", () => {
  it("keeps composition text at the cursor when it fits", () => {
    expect(calculateCompositionShift(80, 120, 320)).toBe(0);
  });

  it("moves composition text left when it crosses the right edge", () => {
    expect(calculateCompositionShift(304, 228, 312)).toBe(-220);
  });

  it("fits composition text wider than the terminal to the full surface", () => {
    expect(calculateCompositionShift(200, 500, 312)).toBe(-200);
  });

  it("ignores invalid measurements", () => {
    expect(calculateCompositionShift(100, 80, 0)).toBe(0);
    expect(calculateCompositionShift(Number.NaN, 80, 320)).toBe(0);
  });
});

describe("terminal visual cursor detection", () => {
  it("finds one isolated inverse-video cell in the visible viewport", () => {
    const buffer = createBuffer([
      [false, false, false, false],
      [false, false, true, false],
    ]);

    expect(findVisualCursor(buffer, 2, 4)).toEqual({ column: 2, row: 1 });
  });

  it("converts absolute buffer rows to viewport rows", () => {
    const buffer = createBuffer([[false, true, false]], 12);

    expect(findVisualCursor(buffer, 1, 3)).toEqual({ column: 1, row: 0 });
  });

  it("accepts an inverse cursor on a wide character", () => {
    const buffer = createBuffer([[{ inverse: true, width: 2 }, { inverse: true, width: 0 }, false]]);

    expect(findVisualCursor(buffer, 1, 3)).toEqual({ column: 0, row: 0 });
  });

  it("rejects inverse runs used for selected rows", () => {
    const buffer = createBuffer([[false, true, true, true, false]]);

    expect(findVisualCursor(buffer, 1, 5)).toBeUndefined();
  });

  it("falls back to the hardware cursor when multiple isolated candidates exist", () => {
    const buffer = createBuffer([[false, true, false, true, false]]);

    expect(findVisualCursor(buffer, 1, 5)).toBeUndefined();
  });
});
