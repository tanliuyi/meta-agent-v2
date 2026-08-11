import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { getPluginIconUrl, type PublishPluginState } from "@/api.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { PluginAvatar } from "./plugin-avatar.tsx";
import { PluginVersionDialog } from "./plugin-version-dialog.tsx";
import { PluginVersionList } from "./plugin-version-list.tsx";

export function PluginWorkspace({
  plugin,
  token,
  onEdit,
}: {
  plugin: PublishPluginState;
  token: string;
  onEdit(): void;
}) {
  const [versionDialogOpen, setVersionDialogOpen] = useState(false);

  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="flex min-w-0 gap-3">
            <PluginAvatar
              name={plugin.name}
              iconUrl={getPluginIconUrl(plugin.id, plugin.iconAssetId)}
              className="size-11"
            />
            <div className="min-w-0">
              <CardTitle className="truncate text-base">{plugin.name}</CardTitle>
              <CardDescription className="mt-1 truncate font-mono text-xs">{plugin.id}</CardDescription>
              <p className="mt-3 max-w-3xl text-sm text-muted-foreground">{plugin.description}</p>
            </div>
          </div>
          <Button variant="outline" size="sm" type="button" onClick={onEdit}>
            <Pencil />
            编辑资料
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Tabs defaultValue="versions">
          <div className="flex flex-col justify-between gap-3 border-b px-6 py-3 sm:flex-row sm:items-center">
            <TabsList>
              <TabsTrigger value="versions">版本</TabsTrigger>
              <TabsTrigger value="metadata">资料</TabsTrigger>
            </TabsList>
            <Button size="sm" type="button" onClick={() => setVersionDialogOpen(true)}>
              <Plus />
              新建版本
            </Button>
          </div>
          <TabsContent value="versions" className="m-0 p-6">
            <PluginVersionList plugin={plugin} token={token} />
          </TabsContent>
          <TabsContent value="metadata" className="m-0 p-6">
            <dl className="grid gap-5 text-sm sm:grid-cols-2">
              <MetadataItem label="发布者" value={plugin.publisherId} technical />
              <MetadataItem label="图标" value={plugin.iconAssetId ? "独立图标" : "版本图标"} technical />
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium text-muted-foreground">分类</dt>
                <dd className="mt-2 flex flex-wrap gap-2">
                  {plugin.categories.length ? (
                    plugin.categories.map((category) => (
                      <Badge variant="secondary" key={category}>
                        {category}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">未设置</span>
                  )}
                </dd>
              </div>
            </dl>
          </TabsContent>
        </Tabs>
      </CardContent>

      <PluginVersionDialog
        open={versionDialogOpen}
        pluginId={plugin.id}
        token={token}
        onOpenChange={setVersionDialogOpen}
      />
    </Card>
  );
}

function MetadataItem({ label, value, technical = false }: { label: string; value: string; technical?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={technical ? "mt-1 font-mono text-xs" : "mt-1"}>{value}</dd>
    </div>
  );
}
