import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import type { WorkbenchPanelValue } from "./panel-model.ts";

interface PanelTabProps {
  value: WorkbenchPanelValue;
  label: string;
  icon: ReactNode;
}

/** 渲染支持 roving focus 与方向键切换的 Workbench tab。 */
export function PanelTab({ value, label, icon }: PanelTabProps) {
  return (
    <Tabs.Trigger className="panel-tab" value={value} aria-label={label} title={label}>
      {icon}
      <span className="panel-tab-label">{label}</span>
    </Tabs.Trigger>
  );
}
