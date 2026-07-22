import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "../src/renderer/src/shared/ui/switch.tsx";

describe("Switch", () => {
  it("提供受控 switch 语义和视觉状态", () => {
    const markup = renderToStaticMarkup(
      <Switch checked onCheckedChange={() => undefined} aria-label="显示 Thinking" />,
    );

    expect(markup).toContain('role="switch"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('data-state="checked"');
  });
});
