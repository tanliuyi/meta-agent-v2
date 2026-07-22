import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectItem } from "../src/renderer/src/components/layout/project-item.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { DesktopProvider } from "../src/renderer/src/state/desktop-context.tsx";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import type { Project } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "C:/workspace",
  lastOpenedAt: 1,
  available: true,
};

describe("ProjectItem", () => {
  it("当前会话路由所属 Project 首帧保持展开", () => {
    const markup = renderToStaticMarkup(
      <DesktopStoreProvider>
        <DesktopProvider>
          <TooltipProvider>
            <ProjectItem project={project} active newTaskDisabled={false} onNewTask={vi.fn()} />
          </TooltipProvider>
        </DesktopProvider>
      </DesktopStoreProvider>,
    );

    expect(markup).toContain('data-project-id="project"');
    expect(markup).toContain('data-active="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('id="project-threads-project"');
    expect(markup).not.toContain('id="project-threads-project" hidden=""');
  });
});
