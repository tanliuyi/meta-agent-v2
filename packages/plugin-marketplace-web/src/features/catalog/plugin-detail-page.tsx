import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BadgeCheck, CircleAlert, Download, Star } from "lucide-react";
import { usePluginDetail } from "@/api-hooks.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { PluginAvatar } from "@/features/plugins/plugin-avatar.tsx";
import { categoryLabel, dateFormatter, errorMessage, numberFormatter } from "@/lib/marketplace-ui.ts";
import { PluginRatingsPanel } from "./plugin-ratings-panel.tsx";
import { PluginVersionPanel } from "./plugin-version-panel.tsx";

export function PluginDetailPage({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate();
  const pluginQuery = usePluginDetail(pluginId);

  if (pluginQuery.isPending) return <DetailSkeleton />;

  if (pluginQuery.isError || !pluginQuery.data) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex min-h-80 flex-col items-center justify-center gap-3 p-8 text-center">
          <CircleAlert className="text-destructive" size={24} />
          <div>
            <h2 className="text-sm font-semibold">无法加载插件</h2>
            <p className="mt-1 text-sm text-muted-foreground">{errorMessage(pluginQuery.error)}</p>
          </div>
          <Button variant="outline" size="sm" type="button" onClick={() => navigate({ to: "/catalog" })}>
            返回目录
          </Button>
        </CardContent>
      </Card>
    );
  }

  const plugin = pluginQuery.data;

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" type="button" className="-ml-2" onClick={() => navigate({ to: "/catalog" })}>
        <ArrowLeft />
        返回市场目录
      </Button>

      <Card>
        <CardHeader className="border-b">
          <div className="flex flex-col justify-between gap-5 md:flex-row md:items-start">
            <div className="flex min-w-0 gap-4">
              <PluginAvatar name={plugin.name} iconUrl={plugin.iconUrl} className="size-12" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <CardTitle className="truncate text-lg">{plugin.name}</CardTitle>
                  {plugin.publisher.verified ? <BadgeCheck className="shrink-0 text-primary" size={17} /> : null}
                </div>
                <CardDescription className="mt-1 font-mono text-xs">{plugin.id}</CardDescription>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">{plugin.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {plugin.categories.map((entry) => (
                    <Badge variant="secondary" key={entry}>
                      {categoryLabel(entry)}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid min-w-60 grid-cols-3 divide-x rounded-lg border bg-muted/20">
              <Metric label="评分" value={plugin.rating.average?.toFixed(1) ?? "-"} icon={Star} />
              <Metric label="下载" value={numberFormatter.format(plugin.downloadCount)} icon={Download} />
              <Metric label="更新" value={dateFormatter.format(plugin.updatedAt)} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Tabs defaultValue="versions">
            <div className="border-b px-6 py-3">
              <TabsList>
                <TabsTrigger value="versions">版本与制品</TabsTrigger>
                <TabsTrigger value="ratings">社区评价</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="versions" className="m-0 p-6">
              <PluginVersionPanel
                pluginId={plugin.id}
                versions={plugin.versions}
                initialVersion={plugin.latestVersion}
              />
            </TabsContent>
            <TabsContent value="ratings" className="m-0 p-6">
              <PluginRatingsPanel pluginId={plugin.id} />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, icon: Icon }: { label: string; value: string; icon?: typeof Star }) {
  return (
    <div className="min-w-0 p-3 text-center">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <strong className="mt-1 flex items-center justify-center gap-1 truncate text-xs font-medium">
        {Icon ? <Icon size={13} /> : null}
        {value}
      </strong>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-[560px] rounded-xl" />
    </div>
  );
}
