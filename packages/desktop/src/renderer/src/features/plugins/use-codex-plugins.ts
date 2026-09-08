import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CodexPluginSummary, CodexPluginsSnapshot } from "../../../../shared/codex-plugin-contracts.ts";

export function useCodexPlugins(query = "") {
  const [snapshot, setSnapshot] = useState<CodexPluginsSnapshot>();
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    plugin: CodexPluginSummary;
    action: "install" | "update" | "uninstall";
  }>();
  const mounted = useRef(true);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.desktop.codexPlugins.list();
      if (mounted.current) setSnapshot(next);
    } catch (reason) {
      if (mounted.current) setError(message(reason));
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const executeMutation = useCallback(
    async (plugin: CodexPluginSummary, action: "install" | "update" | "uninstall" | "toggle") => {
      if (!snapshot || pendingId) return false;
      setPendingId(plugin.id);
      setError(undefined);
      setNotice(undefined);
      try {
        const base = { requestId: crypto.randomUUID(), expectedRevision: snapshot.revision, pluginId: plugin.id };
        const result =
          action === "install"
            ? await window.desktop.codexPlugins.install({ ...base, confirmFullTrust: true })
            : action === "update"
              ? await window.desktop.codexPlugins.update({ ...base, confirmFullTrust: true })
              : action === "uninstall"
                ? await window.desktop.codexPlugins.uninstall({ ...base, confirmRemoval: true })
                : await window.desktop.codexPlugins.setEnabled({ ...base, enabled: !plugin.enabled });
        if (!mounted.current) return false;
        setSnapshot(result.status === "conflict" ? result.current : result.snapshot);
        setNotice(result.status === "conflict" ? undefined : actionNotice(action, plugin.enabled));
        if (result.status === "conflict") setError("插件状态已在其他窗口更新，请重试");
        return true;
      } catch (reason) {
        if (mounted.current) setError(message(reason));
        return false;
      } finally {
        if (mounted.current) setPendingId(undefined);
      }
    },
    [pendingId, snapshot],
  );
  const mutate = useCallback(
    async (plugin: CodexPluginSummary, action: "install" | "update" | "uninstall" | "toggle") => {
      if (action === "toggle") return executeMutation(plugin, action);
      setPendingConfirmation({ plugin, action });
    },
    [executeMutation],
  );
  const confirmMutation = useCallback(async () => {
    const pending = pendingConfirmation;
    if (!pending) return;
    const succeeded = await executeMutation(pending.plugin, pending.action);
    if (!succeeded) throw new Error("Codex plugin mutation failed");
    if (mounted.current) setPendingConfirmation(undefined);
  }, [executeMutation, pendingConfirmation]);

  const normalized = query.trim().toLocaleLowerCase();
  const plugins = useMemo(
    () =>
      (snapshot?.plugins ?? []).filter((plugin) =>
        [plugin.displayName, plugin.id, plugin.description, plugin.developerName, ...plugin.keywords]
          .join("\n")
          .toLocaleLowerCase()
          .includes(normalized),
      ),
    [normalized, snapshot],
  );
  const clearError = useCallback(() => setError(undefined), []);
  const clearNotice = useCallback(() => setNotice(undefined), []);
  return {
    snapshot,
    plugins,
    loading,
    pendingId,
    pendingConfirmation,
    error,
    notice,
    refresh,
    mutate,
    confirmMutation,
    cancelMutation: () => setPendingConfirmation(undefined),
    clearError,
    clearNotice,
  };
}

function actionNotice(action: "install" | "update" | "uninstall" | "toggle", enabled: boolean): string {
  if (action === "install") return "插件已安装；新会话自动生效";
  if (action === "update") return "插件已更新；当前会话需要重新加载";
  if (action === "uninstall") return "插件已卸载；当前会话需要重新加载";
  return `插件已${enabled ? "停用" : "启用"}；新会话自动生效`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
