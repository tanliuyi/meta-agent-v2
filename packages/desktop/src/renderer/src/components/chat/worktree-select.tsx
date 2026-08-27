import type { GitWorktree } from "../../../../shared/contracts.ts";
import { Select } from "../assistant-ui/select/select.tsx";

interface WorktreeSelectProps {
  className?: string;
  worktrees: readonly GitWorktree[];
  value: string | null;
  disabled: boolean;
  onValueChange(path: string): void;
}

export function WorktreeSelect({ className, worktrees, value, disabled, onValueChange }: WorktreeSelectProps) {
  return (
    <Select
      className={className}
      value={value ?? ""}
      options={worktrees.map((worktree) => ({
        value: worktree.path,
        label: worktree.branch ?? worktree.head.slice(0, 7),
        description: worktree.path,
      }))}
      placeholder="选择工作树"
      tooltip="选择 Git worktree"
      disabled={disabled}
      onValueChange={(path) => {
        if (path.length > 0) onValueChange(path);
      }}
    />
  );
}
