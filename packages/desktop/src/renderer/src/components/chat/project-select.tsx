import { GENERAL_WORKSPACE_ID, type Project } from "../../../../shared/contracts.ts";
import { Select } from "../assistant-ui/select/select.tsx";

interface ProjectSelectProps {
  projects: readonly Project[];
  projectId: string | null;
  disabled: boolean;
  onValueChange(projectId: string): void;
}

/** 仅供新会话草稿选择目标 Project。包含通用对话选项。 */
export function ProjectSelect({ projects, projectId, disabled, onValueChange }: ProjectSelectProps) {
  const options = projects.flatMap((project) => {
    if (project.id === GENERAL_WORKSPACE_ID) {
      return {
        value: project.id,
        label: "对话",
        disabled: !project.available,
      };
    }
    return {
      value: project.id,
      label: project.name,
      disabled: !project.available,
    };
  });

  return (
    <Select
      value={projectId ?? ""}
      options={options}
      placeholder="选择会话目标"
      tooltip="选择项目"
      disabled={disabled}
      onValueChange={(nextProjectId) => {
        if (nextProjectId.length > 0) onValueChange(nextProjectId);
      }}
    />
  );
}
