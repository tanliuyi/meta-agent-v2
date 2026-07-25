import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ProviderConnectionForm } from "../src/renderer/src/features/settings/provider-connection-form.tsx";

const select = vi.hoisted(() => vi.fn((_props: unknown) => null));

vi.mock("../src/renderer/src/components/assistant-ui/select/select.tsx", () => ({ Select: select }));

describe("ProviderConnectionForm", () => {
  test("ignores built-in Select value replay and writes changed Auth Header as a boolean", () => {
    const onChange = vi.fn();
    renderToStaticMarkup(
      createElement(ProviderConnectionForm, {
        entryKey: "meta-agent",
        defaultConfig: {
          name: "Meta Agent Provider",
          baseUrl: "http://meta-agent.test",
          api: "openai-responses",
          authHeader: true,
        },
        knownApis: ["openai-responses"],
        onChange,
      }),
    );
    const selects = select.mock.calls.map(
      ([props]) => props as { options?: Array<{ value: string }>; onValueChange(value: string): void },
    );
    const apiSelect = selects.find((props) => props.options?.some((option) => option.value === "openai-responses"));
    const authHeaderSelect = selects.find((props) => props.options?.some((option) => option.value === "true"));
    if (!apiSelect || !authHeaderSelect) throw new Error("Provider Select props were not captured");

    apiSelect.onValueChange("openai-responses");
    authHeaderSelect.onValueChange("true");
    expect(onChange).not.toHaveBeenCalled();

    authHeaderSelect.onValueChange("false");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ config: { authHeader: false } }));
  });
});
