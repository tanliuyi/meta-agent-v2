import { ConfirmDialog } from "@renderer/shared/ui/confirm-dialog";
import type { CodexPluginSummary } from "../../../../shared/codex-plugin-contracts.ts";

export function CodexPluginMutationConfirmation({
  pending,
  onCancel,
  onConfirm,
}: {
  pending?: { plugin: CodexPluginSummary; action: "install" | "update" | "uninstall" };
  onCancel(): void;
  onConfirm(): Promise<void>;
}) {
  const action = pending?.action;
  const plugin = pending?.plugin;
  const destructive = action === "uninstall";
  return (
    <ConfirmDialog
      open={pending !== undefined}
      title={`${destructive ? "卸载" : action === "update" ? "更新" : "安装"} ${plugin?.displayName ?? "插件"}？`}
      description={
        destructive
          ? "卸载会停止新会话加载该插件。现有会话需要重新加载。"
          : "Codex 插件以全信任方式运行，可在你的账户权限下读写文件、访问网络、读取环境变量并执行程序。仅在你信任此插件来源时继续。"
      }
      confirmLabel={destructive ? "确认卸载" : action === "update" ? "信任并更新" : "信任并安装"}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      onConfirm={onConfirm}
    />
  );
}
