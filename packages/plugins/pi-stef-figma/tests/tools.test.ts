import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";

import figmaExtension from "../extensions/figma";
import { cappedJson } from "../src/toolResult";
import { downloadImageUrls, ensureSafeOutputPath } from "../src/transform/assets";

class FakePi {
  tools: Array<{ name: string; parameters?: unknown; execute: (...args: any[]) => Promise<any> }> = [];

  getConfig(): Record<string, unknown> {
    return {};
  }

  registerTool(tool: { name: string; parameters?: unknown; execute: (...args: any[]) => Promise<any> }): void {
    this.tools.push(tool);
  }
}

describe("figma REST tool surface", () => {
  it("registers processed REST tools plus raw escape hatches", () => {
    const pi = new FakePi();

    figmaExtension(pi as never);

    expect(pi.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "figma_context",
        "figma_parse_url",
        "figma_auth_status",
        "figma_get_design_context",
        "figma_get_node_summary",
        "figma_get_implementation_context",
        "figma_extract_text",
        "figma_find_nodes_by_name",
        "figma_find_nodes_by_text",
        "figma_render_nodes",
        "figma_extract_assets",
        "figma_get_styles",
        "figma_get_variables",
        "figma_get_components",
        "figma_get_component_sets",
        "figma_search_components",
        "figma_get_comments",
        "figma_get_image_fills",
        "figma_get_file_raw",
        "figma_get_nodes_raw",
      ]),
    );
  });

  it("registers OpenAI-compatible object parameter schemas for every tool", () => {
    const pi = new FakePi();

    figmaExtension(pi as never);

    for (const tool of pi.tools) {
      expect((tool.parameters as { type?: string } | undefined)?.type, tool.name).toBe("object");
    }
  });

  it("figma_parse_url accepts URLs, file keys, and node id formats", async () => {
    const pi = new FakePi();
    figmaExtension(pi as never);

    const result = await pi.tools.find((tool) => tool.name === "figma_parse_url")?.execute(
      "call-1",
      { input: "https://www.figma.com/design/abc123/FH?node-id=1-2" },
      undefined,
    );

    expect(result?.details).toMatchObject({ fileKey: "abc123", nodeId: "1:2" });
  });

  it("figma_search_components exposes a required query option", () => {
    const pi = new FakePi();
    figmaExtension(pi as never);

    const schema = JSON.stringify(pi.tools.find((tool) => tool.name === "figma_search_components")?.parameters);

    expect(schema).toContain('"query"');
  });

  it("figma_auth_status reports missing config without a network call when no file key is provided", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "figma-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const pi = new FakePi();
      figmaExtension(pi as never);

      const result = await pi.tools.find((tool) => tool.name === "figma_auth_status")?.execute(
        "call-1",
        {},
        undefined,
      );

      expect(result?.details).toMatchObject({ configured: false });
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("figma_auth_status reports configured when the Desktop config provides apiToken", async () => {
    const pi = new FakePi();
    (pi as unknown as { config: Record<string, unknown> }).config = { apiToken: "desktop-token" };
    pi.getConfig = () => (pi as unknown as { config: Record<string, unknown> }).config;
    figmaExtension(pi as never);

    const result = await pi.tools.find((tool) => tool.name === "figma_auth_status")?.execute(
      "call-1",
      {},
      undefined,
    );

    expect(result?.details).toMatchObject({ configured: true });
    expect(JSON.stringify(result)).not.toContain("desktop-token");
  });

  it("rejects outputDir traversal and symlink escapes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-assets-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "figma-outside-"));
    const link = path.join(root, "link");
    fs.symlinkSync(outside, link);
    const nested = path.join(root, "nested-link");
    fs.symlinkSync(outside, nested);

    expect(() => ensureSafeOutputPath("../outside", root)).toThrow("outside");
    expect(() => ensureSafeOutputPath(link, root)).toThrow("outside");
    expect(() => ensureSafeOutputPath(path.join("nested-link", "asset.png"), root)).toThrow("outside");
    expect(ensureSafeOutputPath("safe", root)).toBe(path.join(fs.realpathSync(root), "safe"));
  });

  it("marks capped JSON output as truncated", () => {
    expect(cappedJson({ value: "abcdef" }, 10)).toContain("truncated at 10 characters");
  });

  it("skips oversized downloads before writing assets", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "figma-assets-"));
    const fetchMock = vi.fn(async () => new Response("too large", { headers: { "Content-Length": "11" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadImageUrls({ "1:2": "https://img.example/render" }, "safe", root, 10);

    expect(result).toEqual([{ nodeId: "1:2", path: "", skipped: "Download exceeds 10 bytes." }]);
    expect(fs.existsSync(path.join(root, "safe", "1_2.bin"))).toBe(false);
  });
});
