import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectSection,
  shouldAutoExpandProjectsSection,
} from "../src/renderer/src/components/layout/project-section.tsx";
import { TooltipProvider } from "../src/renderer/src/shared/ui/tooltip-provider.tsx";
import { preferencesStorage } from "../src/renderer/src/state/preferences-store.ts";
import { PROJECT_EXPANSION_STORAGE_KEY } from "../src/renderer/src/state/project-expansion-preference.ts";

vi.mock("../src/renderer/src/components/layout/project-list.tsx", () => ({
  ProjectList: () => <ul data-slot="project-list" />,
}));

vi.mock("../src/renderer/src/state/keyboard-shortcut-provider.tsx", () => ({
  useKeyboardShortcuts: () => ({
    getBindings: () => [{ modifiers: ["mod"], key: "o" }],
  }),
}));

beforeEach(() => {
  preferencesStorage.reset();
  vi.stubGlobal("window", {
    desktop: {
      platform: "win32",
      preferences: {
        getInitial: () => ({ path: "preferences.json", exists: true, values: {} }),
        save: () => Promise.resolve({ status: "saved" }),
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSection(activeProjectId: string | null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ProjectSection
        activeProjectId={activeProjectId}
        newTaskDisabled={false}
        onNewTask={vi.fn()}
        onAddProject={vi.fn(async () => undefined)}
      />
    </TooltipProvider>,
  );
}

describe("shouldAutoExpandProjectsSection", () => {
  it("expands when the active project changes from null to a project id", () => {
    expect(shouldAutoExpandProjectsSection(null, "project-a")).toBe(true);
  });

  it("expands when the active project changes from one id to another", () => {
    expect(shouldAutoExpandProjectsSection("project-a", "project-b")).toBe(true);
  });

  it("does not expand when becoming inactive or staying inactive", () => {
    expect(shouldAutoExpandProjectsSection("project-a", null)).toBe(false);
    expect(shouldAutoExpandProjectsSection(null, null)).toBe(false);
  });

  it("does not expand when the same project stays active", () => {
    expect(shouldAutoExpandProjectsSection("project-a", "project-a")).toBe(false);
  });
});

describe("ProjectSection", () => {
  it("renders expanded on first frame when a project is active", () => {
    const markup = renderSection("project-a");

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('data-slot="project-list"');
  });

  it("restores a persisted collapsed state on first frame", () => {
    preferencesStorage.reset();
    vi.stubGlobal("window", {
      desktop: {
        platform: "win32",
        preferences: {
          getInitial: () => ({
            path: "preferences.json",
            exists: true,
            values: {
              [PROJECT_EXPANSION_STORAGE_KEY]: JSON.stringify({
                version: 1,
                projects: [["__sidebar-projects__", false]],
              }),
            },
          }),
          save: () => Promise.resolve({ status: "saved" }),
        },
      },
    });

    const markup = renderSection("project-a");
    expect(markup).toContain('aria-expanded="false"');
  });
});
