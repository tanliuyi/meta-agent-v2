import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PluginSelect } from "../src/renderer/src/components/chat/plugin-select.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";

const popoverContent = vi.hoisted(() => ({ className: "" }));

vi.mock("../src/renderer/src/shared/ui/popover-content.tsx", () => ({
  PopoverContent: ({ className }: { className?: string }) => {
    popoverContent.className = className ?? "";
    return <div data-slot="popover-content" />;
  },
}));

describe("plugin icons", () => {
  it("elevates the plugin select popover above the fullscreen session modal", () => {
    renderToStaticMarkup(
      <TooltipProvider>
        <PluginSelect plugins={[]} value={null} onValueChange={() => undefined} />
      </TooltipProvider>,
    );
    expect(popoverContent.className).toContain("z-(--stack-menu)");
  });

  it("renders generated fallback icons for Codex and development plugins", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <PluginSelect
          plugins={[
            { id: "codex-plugin", displayName: "Codex", source: "codex", available: true },
            { id: "development:local", displayName: "Local", source: "development", available: true },
          ]}
          value={null}
          onValueChange={() => undefined}
        />
      </TooltipProvider>,
    );
    expect(markup).toContain(">C</span>");
    expect(markup).toContain(">L</span>");
  });
});
