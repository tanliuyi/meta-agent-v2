import { describe, expect, test } from "vitest";
import { currentCsvToken, replaceCurrentCsvToken } from "../src/renderer/src/shared/ui/combobox.tsx";

describe("subagent settings models", () => {
  test("filters skill suggestions using only the unfinished CSV token", () => {
    expect(currentCsvToken("runtime, mark")).toBe("mark");
    expect(currentCsvToken("runtime, ")).toBe("");
  });

  test("adds a selected skill without replacing existing skills", () => {
    expect(replaceCurrentCsvToken("runtime, mark", "markdown")).toBe("runtime, markdown");
    expect(replaceCurrentCsvToken("runtime, ", "markdown")).toBe("runtime, markdown");
    expect(replaceCurrentCsvToken("runtime, runtime", "runtime")).toBe("runtime");
  });
});
