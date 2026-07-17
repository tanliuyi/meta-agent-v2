import { BranchPickerPrimitive } from "@assistant-ui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../../lib/cn.ts";
import { TooltipIconButton } from "../../assistant-ui/tooltip-icon-button.tsx";

export function BranchPicker({ className, ...props }: ComponentProps<typeof BranchPickerPrimitive.Root>) {
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root text-muted-foreground -ms-2 me-2 inline-flex items-center text-xs",
        className,
      )}
      {...props}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip="上一个分支">
          <ChevronLeft />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip="下一个分支">
          <ChevronRight />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}
