import { useNavigate } from "@tanstack/react-router";
import { Box, CircleAlert, FileArchive, type LucideIcon, Package, Rocket, UsersRound } from "lucide-react";
import { useCurrentUser, useManagedPlugins, useSession } from "@/api-hooks.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";

export function PublisherDashboard() {
  const navigate = useNavigate();
  const { data: session } = useSession();
  const token = session?.token ?? null;
  const currentUser = useCurrentUser(token);
  const managedPlugins = useManagedPlugins(token);

  if (!token) return null;
  if (currentUser.isPending || managedPlugins.isPending) return <DashboardSkeleton />;
  if (currentUser.isError || managedPlugins.isError) {
    return (
      <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-background p-8 text-center">
        <CircleAlert className="text-destructive" size={24} />
        <div>
          <h2 className="text-sm font-semibold">无法加载工作区</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {errorMessage(currentUser.error ?? managedPlugins.error)}
          </p>
        </div>
        <Button variant="outline" size="sm" type="button" onClick={() => managedPlugins.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  const plugins = managedPlugins.data?.plugins ?? [];
  const versions = plugins.flatMap((plugin) => plugin.versions);
  const metrics = [
    { title: "插件", value: plugins.length, description: "当前账号可管理", icon: Package },
    {
      title: "已发布版本",
      value: versions.filter((version) => !version.draft).length,
      description: "市场公开版本",
      icon: Rocket,
    },
    {
      title: "版本草稿",
      value: versions.filter((version) => version.draft).length,
      description: "等待发布处理",
      icon: FileArchive,
    },
    {
      title: "待上传制品",
      value: versions
        .flatMap((version) => (version.draft ? version.artifacts : []))
        .filter((artifact) => !artifact.uploaded).length,
      description: "草稿中未完成",
      icon: Box,
    },
  ];
  const publisherIds = currentUser.data?.publisherIds ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-normal">发布概览</h2>
          <p className="mt-1 text-sm text-muted-foreground">查看插件、版本和待处理制品的当前状态。</p>
        </div>
        <Button type="button" onClick={() => navigate({ to: "/manage" })}>
          <Package />
          管理插件
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <MetricCard {...metric} key={metric.title} />
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近管理的插件</CardTitle>
            <CardDescription>版本状态和制品完整度。</CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            {plugins.length ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-6">插件</TableHead>
                    <TableHead>发布者</TableHead>
                    <TableHead>版本</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead className="pr-6 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plugins.slice(0, 8).map((plugin) => {
                    const drafts = plugin.versions.filter((version) => version.draft).length;
                    return (
                      <TableRow key={plugin.id}>
                        <TableCell className="pl-6">
                          <div className="min-w-44">
                            <strong className="block truncate text-sm font-medium">{plugin.name}</strong>
                            <span className="block truncate font-mono text-xs text-muted-foreground">{plugin.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>{plugin.publisherId}</TableCell>
                        <TableCell>{plugin.versions.length}</TableCell>
                        <TableCell>
                          {drafts ? (
                            <Badge variant="secondary">{drafts} 个草稿</Badge>
                          ) : (
                            <Badge variant="outline">已同步</Badge>
                          )}
                        </TableCell>
                        <TableCell className="pr-6 text-right">
                          <Button variant="ghost" size="sm" type="button" onClick={() => navigate({ to: "/manage" })}>
                            查看
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            ) : (
              <div className="flex min-h-52 flex-col items-center justify-center gap-3 border-t p-6 text-center">
                <Package className="text-muted-foreground" size={24} />
                <div>
                  <p className="text-sm font-medium">尚未创建插件</p>
                  <p className="text-xs text-muted-foreground">前往“我的插件”创建第一条记录。</p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <UsersRound size={17} />
              发布者权限
            </CardTitle>
            <CardDescription>当前账号所属的发布者。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {publisherIds.length ? (
              publisherIds.map((publisherId) => (
                <div className="flex items-center justify-between rounded-md border px-3 py-2" key={publisherId}>
                  <span className="font-mono text-xs">{publisherId}</span>
                  <Badge variant="outline">成员</Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">尚未加入任何发布者。</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  description,
  icon: Icon,
}: {
  title: string;
  value: number;
  description: string;
  icon: LucideIcon;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="text-muted-foreground" size={17} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton className="h-32 rounded-xl" key={key} />
        ))}
      </div>
      <Skeleton className="h-80 rounded-xl" />
    </div>
  );
}
