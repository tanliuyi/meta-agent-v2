import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SubagentFormField } from "../src/renderer/src/features/settings/subagents/subagent-form-field.tsx";
import { SubagentToggleField } from "../src/renderer/src/features/settings/subagents/subagent-toggle-field.tsx";

describe("subagent form field accessibility", () => {
  it("associates field labels with their controls", () => {
    const markup = renderToStaticMarkup(
      <SubagentFormField label="名称">
        {({ controlId, labelId }) => <input id={controlId} aria-labelledby={labelId} />}
      </SubagentFormField>,
    );
    const label = /<label id="([^"]+)" for="([^"]+)">名称<\/label>/.exec(markup);

    expect(label).not.toBeNull();
    expect(markup).toContain(`id="${label?.[2]}"`);
    expect(markup).toContain(`aria-labelledby="${label?.[1]}"`);
  });

  it("associates toggle labels with the switch button", () => {
    const markup = renderToStaticMarkup(
      <SubagentToggleField label="启用" defaultChecked onCheckedChange={() => undefined} />,
    );
    const controlId = /<label for="([^"]+)">启用<\/label>/.exec(markup)?.[1];

    expect(controlId).toBeTruthy();
    expect(markup).toContain(`id="${controlId}"`);
    expect(markup).toContain('role="switch"');
  });
});
