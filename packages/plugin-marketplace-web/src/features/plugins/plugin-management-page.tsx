import { useNavigate } from "@tanstack/react-router";
import { Box, CircleAlert, LogIn, PackagePlus, Plus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { getPluginIconUrl, type PublishPluginState } from "@/api.ts";
import { useCurrentUser, useManagedPlugins, useSession } from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";
import { PluginAvatar } from "./plugin-avatar.tsx";
import { PluginMetadataDialog } from "./plugin-metadata-dialog.tsx";
import { PluginWorkspace } from "./plugin-workspace.tsx";

export function PluginManagementPage() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const token = session?.token ?? null;
  const currentUser = useCurrentUser(token);
  const managedPlugins = useManagedPlugins(token);
  const plugins = managedPlugins.data?.plugins ?? [];
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [metadataDialog, setMetadataDialog] = useState<PublishPluginState | "new" | null>(null);

  useEffect(() => {
    if (!plugins.length) {
      setSelectedPluginId(undefined);
      return;
    }
    if (!selectedPluginId || !plugins.some((plugin) => plugin.id === selectedPluginId)) {
      setSelectedPluginId(plugins[0]!.id);
    }
  }, [plugins, selectedPluginId]);

  if (!token) {
    return (
      <EmptyWorkspace
        icon={LogIn}
        title="登录后管理插件"
        description="插件资料、版本草稿和发布操作仅对发布者成员开放。"
      >
        <Button type="button" onClick={() => navigate({ to: "/login" })}>
          <LogIn />
          登录
        </Button>
      </EmptyWorkspace>
    );
  }

  if (currentUser.isPending || managedPlugins.isPending) return <ManagementSkeleton />;

  if (currentUser.isError || managedPlugins.isError) {
    return (
      <Alert variant="destructive">
        <CircleAlert />
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>{errorMessage(currentUser.error ?? managedPlugins.error)}</span>
          <Button variant="outline" size="sm" type="button" onClick={() => managedPlugins.refetch()}>
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const publisherIds = currentUser.data?.publisherIds ?? [];
  if (!publisherIds.length) {
    return (
      <EmptyWorkspace
        icon={Box}
        title="尚未加入发布者"
        description="请联系市场管理员，将账号加入发布者后再创建和发布插件。"
      />
    );
  }

  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId);

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-normal">我的插件</h2>
          <p className="mt-1 text-sm text-muted-foreground">维护插件资料、上传版本制品并管理发布状态。</p>
        </div>
        <Button type="button" onClick={() => setMetadataDialog("new")}>
          <PackagePlus />
          新建插件
        </Button>
      </div>

      {plugins.length ? (
        <div className="grid items-start gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">插件列表</CardTitle>
              <CardDescription>{plugins.length} 个可管理插件</CardDescription>
            </CardHeader>
            <CardContent className="space-y-1 p-2 pt-0">
              {plugins.map((plugin) => (
                <Button
                  variant={plugin.id === selectedPluginId ? "secondary" : "ghost"}
                  type="button"
                  className="h-auto w-full justify-start px-2 py-2 text-left"
                  onClick={() => setSelectedPluginId(plugin.id)}
                  key={plugin.id}
                >
                  <PluginAvatar name={plugin.name} iconUrl={getPluginIconUrl(plugin.id, plugin.iconAssetId)} />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm font-medium">{plugin.name}</strong>
                    <small className="block truncate font-mono text-xs text-muted-foreground">{plugin.id}</small>
                  </span>
                  <Badge variant="outline">{plugin.versions.length}</Badge>
                </Button>
              ))}
            </CardContent>
          </Card>
          {selectedPlugin ? (
            <PluginWorkspace plugin={selectedPlugin} token={token} onEdit={() => setMetadataDialog(selectedPlugin)} />
          ) : null}
        </div>
      ) : (
        <EmptyWorkspace icon={PackagePlus} title="还没有插件" description="先创建插件资料，再声明并上传第一个版本。">
          <Button type="button" onClick={() => setMetadataDialog("new")}>
            <Plus />
            新建插件
          </Button>
        </EmptyWorkspace>
      )}

      <PluginMetadataDialog
        open={metadataDialog !== null}
        plugin={metadataDialog === "new" ? undefined : (metadataDialog ?? undefined)}
        publisherIds={publisherIds}
        token={token}
        onOpenChange={(open) => {
          if (!open) setMetadataDialog(null);
        }}
        onSaved={(pluginId) => {
          setSelectedPluginId(pluginId);
          setMetadataDialog(null);
        }}
      />
    </div>
  );
}

function EmptyWorkspace({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Box;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center">
        <Icon className="text-muted-foreground" size={26} />
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function ManagementSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-[520px] rounded-xl" />
      </div>
    </div>
  );
}
