import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileTree } from "../src/renderer/src/components/panel/files/file-tree.tsx";
import type { FileNode } from "../src/shared/contracts.ts";

const nodes: FileNode[] = [
  { name: "src", path: "src", type: "directory", hasChildren: true },
  { name: "package.json", path: "package.json", type: "file" },
  { name: "lib", path: "lib", type: "directory", hasChildren: true },
];

describe("FileTree", () => {
  it("渲染节点行并标记活动文件", () => {
    const markup = renderToStaticMarkup(
      <FileTree nodes={nodes} children={{}} expanded={new Set()} active="package.json" onOpen={() => {}} />,
    );
    expect(markup).toContain('role="tree"');
    expect(markup).toContain("src");
    expect(markup).toContain("package.json");
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('draggable="true"');
  });

  it("展开目录时递归渲染子节点，未加载时显示加载行", () => {
    const srcChildren: FileNode[] = [{ name: "index.ts", path: "src/index.ts", type: "file" }];
    const markup = renderToStaticMarkup(
      <FileTree nodes={nodes} children={{ src: srcChildren }} expanded={new Set(["src", "lib"])} onOpen={() => {}} />,
    );
    expect(markup).toContain("index.ts");
    expect(markup).toContain("正在加载");
    expect(markup).toContain('aria-level="2"');
  });

  it("把连续的单子目录链收敛为一行", () => {
    const markup = renderToStaticMarkup(
      <FileTree
        nodes={[{ name: "src", path: "src", type: "directory", hasChildren: true }]}
        children={{
          src: [{ name: "extension", path: "src/extension", type: "directory", hasChildren: true }],
          "src/extension": [{ name: "index.ts", path: "src/extension/index.ts", type: "file" }],
        }}
        expanded={new Set(["src", "src/extension"])}
        onOpen={() => {}}
      />,
    );
    expect(markup.match(/role="treeitem"/gu)).toHaveLength(2);
    expect(markup).toContain("file-row-label-separator");
    expect(markup).toContain("extension");
    expect(markup).toContain('aria-level="2"');
  });

  it("空树渲染为空容器", () => {
    const markup = renderToStaticMarkup(<FileTree nodes={[]} children={{}} expanded={new Set()} onOpen={() => {}} />);
    expect(markup).toContain('role="tree"');
  });
});
