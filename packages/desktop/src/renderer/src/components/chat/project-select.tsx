import type { Project } from "../../../../shared/contracts.ts";
import { Select } from "../assistant-ui/select/select.tsx";

interface ProjectSelectProps {
  projects: readonly Project[];
  projectId: string | null;
  disabled: boolean;
  onValueChange(projectId: string): void;
}

/** 仅供新会话草稿选择目标 Project。 */
export function ProjectSelect({ projects, projectId, disabled, onValueChange }: ProjectSelectProps) {
  return (
    <Select
      value={projectId ?? ""}
      options={projects.map((project) => ({
        value: project.id,
        label: project.name,
        disabled: !project.available,
      }))}
      placeholder="选择项目"
      disabled={disabled}
      onValueChange={(nextProjectId) => {
        if (nextProjectId.length > 0) onValueChange(nextProjectId);
      }}
    />
  );
}
