import { Archive, CircleAlert, FileArchive, LoaderCircle, Rocket, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import type { PublishPluginState, PublishVersionState } from "@/api.ts";
import {
  useDeleteManagedDraft,
  useDeprecateManagedVersion,
  usePublishManagedVersion,
  useUploadManagedArtifact,
} from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";
import { ActionConfirmDialog, type PendingPluginAction } from "./action-confirm-dialog.tsx";
import { PluginStatusBadge } from "./plugin-status-badge.tsx";

export function PluginVersionList({ plugin, token }: { plugin: PublishPluginState; token: string }) {
  const [actionError, setActionError] = useState<string>();
  const [uploadingArtifact, setUploadingArtifact] = useState<string>();
  const [pendingAction, setPendingAction] = useState<PendingPluginAction>();
  const uploadMutation = useUploadManagedArtifact();
  const publishMutation = usePublishManagedVersion();
  const deprecateMutation = useDeprecateManagedVersion();
  const deleteMutation = useDeleteManagedDraft();
  const versions = [...plugin.versions].reverse();

  async function upload(version: string, artifactId: string, file: File): Promise<void> {
    setActionError(undefined);
    setUploadingArtifact(`${version}:${artifactId}`);
    try {
      await uploadMutation.mutateAsync({ pluginId: plugin.id, version, artifactId, file, token });
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setUploadingArtifact(undefined);
    }
  }

  function confirmPublish(version: PublishVersionState): void {
    setPendingAction({
      title: `发布 ${plugin.name} v${version.version}`,
      description: "发布后该版本将公开可见，且不能作为草稿删除。",
      confirmLabel: "确认发布",
      run: async () =>
        runAction(() => publishMutation.mutateAsync({ pluginId: plugin.id, version: version.version, token })),
    });
  }

  function confirmDeprecate(version: string): void {
    setPendingAction({
      title: `废弃 ${plugin.name} v${version}`,
      description: "现有用户仍可下载该版本，但市场会将其标记为已弃用。",
      confirmLabel: "确认废弃",
      run: async () => runAction(() => deprecateMutation.mutateAsync({ pluginId: plugin.id, version, token })),
    });
  }

  function confirmDelete(version: string): void {
    setPendingAction({
      title: `删除草稿 v${version}`,
      description: "草稿及其已上传制品将被永久删除。此操作无法撤销。",
      confirmLabel: "删除草稿",
      destructive: true,
      run: async () => runAction(() => deleteMutation.mutateAsync({ pluginId: plugin.id, version, token })),
    });
  }

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
    } catch (reason) {
      setActionError(errorMessage(reason));
    } finally {
      setPendingAction(undefined);
    }
  }

  if (!versions.length) {
    return (
      <div className="grid min-h-40 place-items-center rounded-lg border border-dashed text-sm text-muted-foreground">
        尚未创建版本。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {actionError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      ) : null}
      <div className="rounded-lg border bg-background">
        {versions.map((version, index) => {
          const complete = version.artifacts.every((artifact) => artifact.uploaded);
          return (
            <article className="p-4" key={version.version}>
              {index ? <Separator className="mb-4" /> : null}
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2">
                  <strong className="font-mono text-sm">v{version.version}</strong>
                  {version.draft ? (
                    <Badge variant="secondary">草稿</Badge>
                  ) : (
                    <PluginStatusBadge status={version.status} />
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {version.draft ? (
                    <>
                      <Button
                        size="sm"
                        type="button"
                        disabled={!complete || publishMutation.isPending}
                        onClick={() => confirmPublish(version)}
                      >
                        {publishMutation.isPending ? <LoaderCircle className="animate-spin" /> : <Rocket />}
                        发布
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        type="button"
                        disabled={deleteMutation.isPending}
                        onClick={() => confirmDelete(version.version)}
                        aria-label={`删除草稿 ${version.version}`}
                        title="删除草稿"
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </>
                  ) : version.status === "available" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      disabled={deprecateMutation.isPending}
                      onClick={() => confirmDeprecate(version.version)}
                    >
                      <Archive />
                      废弃版本
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="mt-3 divide-y rounded-xl border bg-muted/20">
                {version.artifacts.map((artifact) => {
                  const uploadKey = `${version.version}:${artifact.id}`;
                  return (
                    <div className="flex min-h-14 items-center gap-3 px-3 py-2" key={artifact.id}>
                      <FileArchive className="shrink-0 text-muted-foreground" size={17} />
                      <div className="min-w-0 flex-1">
                        <strong className="block truncate font-mono text-xs">{artifact.id}</strong>
                        <span className="block text-xs text-muted-foreground">
                          {artifact.uploaded ? "ZIP 已上传" : "等待上传 ZIP"}
                        </span>
                      </div>
                      {version.draft ? (
                        <Button variant="outline" size="sm" asChild>
                          <label>
                            {uploadingArtifact === uploadKey ? <LoaderCircle className="animate-spin" /> : <Upload />}
                            {artifact.uploaded ? "替换" : "上传"}
                            <input
                              className="sr-only"
                              type="file"
                              accept=".zip,application/zip"
                              disabled={uploadMutation.isPending}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) upload(version.version, artifact.id, file);
                                event.target.value = "";
                              }}
                            />
                          </label>
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
      <ActionConfirmDialog
        action={pendingAction}
        onOpenChange={(open) => {
          if (!open) setPendingAction(undefined);
        }}
      />
    </div>
  );
}
