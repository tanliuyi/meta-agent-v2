import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopThreadList } from "../src/renderer/src/components/layout/desktop-thread-list.tsx";
import { DesktopProvider } from "../src/renderer/src/state/desktop-context.tsx";
import { DesktopStoreProvider } from "../src/renderer/src/state/desktop-store-context.tsx";
import type { Project, Thread } from "../src/shared/contracts.ts";

const project: Project = {
  id: "project",
  name: "Project",
  cwd: "/tmp/project",
  lastOpenedAt: 1,
  available: true,
};

const thread: Thread = {
  id: "new-thread",
  projectId: project.id,
  title: "新会话",
  createdAt: 1,
  updatedAt: 1,
  messageCount: 0,
  preview: "",
  archived: false,
  running: false,
};

describe("DesktopThreadList", () => {
  it("新会话先进入 Desktop catalog 时不读取尚未注册的 assistant-ui item", () => {
    expect(() =>
      renderToStaticMarkup(
        <DesktopStoreProvider>
          <DesktopProvider>
            <DesktopThreadList project={project} threads={[thread]} />
          </DesktopProvider>
        </DesktopStoreProvider>,
      ),
    ).not.toThrow();
  });
});
