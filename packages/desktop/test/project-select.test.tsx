import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProjectSelect } from "../src/renderer/src/components/chat/project-select.tsx";
import type { Project } from "../src/shared/contracts.ts";

const PROJECT = {
  id: "project-a",
  name: "Project A",
  path: "G:/project-a",
  available: true,
} as Project;

describe("ProjectSelect", () => {
  it("忽略 Select 在 options 回填期间发出的空项目值", () => {
    const onValueChange = vi.fn();
    const element = ProjectSelect({
      projects: [PROJECT],
      projectId: null,
      disabled: false,
      onValueChange,
    }) as ReactElement<{ onValueChange(value: string): void }>;

    element.props.onValueChange("");
    expect(onValueChange).not.toHaveBeenCalled();

    element.props.onValueChange(PROJECT.id);
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith(PROJECT.id);
  });
});
