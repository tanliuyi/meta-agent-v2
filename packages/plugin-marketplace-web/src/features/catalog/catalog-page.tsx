import { useNavigate } from "@tanstack/react-router";
import { ArrowDownToLine, BadgeCheck, CircleAlert, LoaderCircle, Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePluginList } from "@/api-hooks.ts";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { PluginAvatar } from "@/features/plugins/plugin-avatar.tsx";
import { categoryLabel, numberFormatter } from "@/lib/marketplace-ui.ts";

export function CatalogPage() {
  const navigate = useNavigate();
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), queryInput ? 250 : 0);
    return () => clearTimeout(timer);
  }, [queryInput]);

  const pluginsQuery = usePluginList({ query, category });
  const plugins = useMemo(() => pluginsQuery.data?.pages.flatMap((page) => page.plugins) ?? [], [pluginsQuery.data]);
  const categories = useMemo(
    () => [...new Set(plugins.flatMap((plugin) => plugin.categories))].sort((left, right) => left.localeCompare(right)),
    [plugins],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-normal">市场目录</h2>
        <p className="mt-1 text-sm text-muted-foreground">查看公开插件、版本状态和市场表现。</p>
      </div>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <CardTitle className="text-base">公开插件</CardTitle>
              <CardDescription className="mt-1">共加载 {plugins.length} 个插件</CardDescription>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-0 sm:w-72">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} />
                <Input
                  type="search"
                  className="pl-9 pr-9"
                  placeholder="搜索插件、描述或发布者"
                  value={queryInput}
                  onChange={(event) => setQueryInput(event.target.value)}
                  aria-label="搜索插件"
                />
                {queryInput ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    className="absolute right-1 top-1/2 -translate-y-1/2"
                    onClick={() => setQueryInput("")}
                    aria-label="清除搜索"
                    title="清除搜索"
                  >
                    <X size={14} />
                  </Button>
                ) : null}
              </div>
              <Select value={category || "all"} onValueChange={(value) => setCategory(value === "all" ? "" : value)}>
                <SelectTrigger className="w-full sm:w-44" aria-label="选择分类">
                  <SelectValue placeholder="全部分类" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部分类</SelectItem>
                  {categories.map((entry) => (
                    <SelectItem value={entry} key={entry}>
                      {categoryLabel(entry)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {pluginsQuery.isError ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-3 border-t p-6 text-center">
              <CircleAlert className="text-destructive" size={24} />
              <p className="text-sm text-muted-foreground">{pluginsQuery.error.message}</p>
              <Button variant="outline" size="sm" type="button" onClick={() => pluginsQuery.refetch()}>
                重试
              </Button>
            </div>
          ) : pluginsQuery.isPending ? (
            <CatalogSkeleton />
          ) : plugins.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">插件</TableHead>
                  <TableHead>分类</TableHead>
                  <TableHead>版本</TableHead>
                  <TableHead>评分</TableHead>
                  <TableHead>下载</TableHead>
                  <TableHead className="pr-6 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plugins.map((plugin) => (
                  <TableRow key={plugin.id}>
                    <TableCell className="pl-6">
                      <div className="flex min-w-64 items-center gap-3">
                        <PluginAvatar name={plugin.name} iconUrl={plugin.iconUrl} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <strong className="truncate text-sm font-medium">{plugin.name}</strong>
                            {plugin.publisher.verified ? (
                              <BadgeCheck className="shrink-0 text-primary" size={14} aria-label="已认证发布者" />
                            ) : null}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {plugin.publisher.displayName} · {plugin.id}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-52 gap-1 overflow-hidden">
                        {plugin.categories.slice(0, 2).map((entry) => (
                          <Badge variant="secondary" key={entry}>
                            {categoryLabel(entry)}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">v{plugin.latestVersion ?? "-"}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1 tabular-nums">
                        <Star className="text-amber-600" size={14} fill="currentColor" />
                        {plugin.rating.average?.toFixed(1) ?? "-"}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{numberFormatter.format(plugin.downloadCount)}</TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        onClick={() => navigate({ to: "/plugin/$pluginId", params: { pluginId: plugin.id } })}
                      >
                        查看
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="flex min-h-52 flex-col items-center justify-center gap-2 border-t p-6 text-center">
              <Search className="text-muted-foreground" size={24} />
              <p className="text-sm font-medium">没有匹配的插件</p>
              <p className="text-xs text-muted-foreground">调整搜索内容或分类后重试。</p>
            </div>
          )}
          {pluginsQuery.hasNextPage ? (
            <div className="flex justify-center border-t p-4">
              <Button
                variant="outline"
                size="sm"
                type="button"
                disabled={pluginsQuery.isFetchingNextPage}
                onClick={() => pluginsQuery.fetchNextPage()}
              >
                {pluginsQuery.isFetchingNextPage ? (
                  <LoaderCircle className="animate-spin" size={15} />
                ) : (
                  <ArrowDownToLine size={15} />
                )}
                加载更多
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function CatalogSkeleton() {
  return (
    <div className="space-y-0 border-t">
      {[0, 1, 2, 3, 4].map((key) => (
        <div className="flex h-16 items-center gap-3 border-b px-6" key={key}>
          <Skeleton className="size-9 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
      ))}
    </div>
  );
}
