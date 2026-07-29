import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "../src/renderer/src/shared/ui/dialog.tsx";
import { DialogDescription } from "../src/renderer/src/shared/ui/dialog-description.tsx";

describe("DialogDescription", () => {
  it("长文本可在对话框内容区内换行", () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogDescription>{"C:/workspace/" + "unbroken-segment".repeat(20)}</DialogDescription>
      </Dialog>,
    );

    expect(markup).toContain("min-w-0");
    expect(markup).toContain("[overflow-wrap:anywhere]");
  });
});
