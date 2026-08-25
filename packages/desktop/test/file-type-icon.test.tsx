import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTypeIcon } from "../src/renderer/src/components/panel/files/file-type-icon.tsx";

describe("FileTypeIcon", () => {
  it.each([
    ["main.tsx", "@ReactIcon"],
    ["env.d.ts", "@Typescript"],
    ["styles.css", "@Css"],
    ["index.html", "@Html"],
    ["package.json", "@Npm"],
    ["README.md", "@Readme"],
    ["script.py", "@Python"],
    ["Dockerfile", "@Docker"],
    ["unknown.zzz", "@Document"],
  ])("按文件名解析 %s", (fileName, iconClass) => {
    const markup = renderToStaticMarkup(<FileTypeIcon name={fileName} />);
    expect(markup).toContain(`class="${iconClass}"`);
    expect(markup).toContain('width="16"');
    expect(markup).toContain('aria-hidden="true"');
  });
});
