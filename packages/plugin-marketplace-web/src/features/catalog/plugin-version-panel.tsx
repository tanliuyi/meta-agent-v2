import { CircleAlert, Download, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { PluginVersionDetail } from "@/api.ts";
import { usePluginDownload } from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { PluginStatusBadge } from "@/features/plugins/plugin-status-badge.tsx";
import { dateFormatter, errorMessage, formatBytes } from "@/lib/marketplace-ui.ts";

export function PluginVersionPanel({
  pluginId,
  versions,
  initialVersion,
}: {
  pluginId: string;
  versions: PluginVersionDetail[];
  initialVersion?: string;
}) {
  const [selectedVersion, setSelectedVersion] = useState(initialVersion ?? versions[0]?.version);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState<string>();
  const downloadMutation = usePluginDownload();
  const version = versions.find((entry) => entry.version === selectedVersion) ?? versions[0];

  async function downloadArtifact(artifactId: string): Promise<void> {
    if (!version) return;
    setDownloading(artifactId);
    setDownloadError(undefined);
    try {
      const metadata = await downloadMutation.mutateAsync({ pluginId, version: version.version, artifactId });
      window.location.assign(metadata.url);
    } catch (reason) {
      setDownloadError(errorMessage(reason));
    } finally {
      setDownloading(undefined);
    }
  }

  if (!version) return <p className="text-sm text-muted-foreground">暂无公开版本。</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex flex-wrap items-center gap-2">
          <PluginStatusBadge status={version.status} />
          <span className="text-xs text-muted-foreground">发布于 {dateFormatter.format(version.publishedAt)}</span>
          <span className="text-xs text-muted-foreground">
            Desktop {version.desktop.minVersion ? `≥ ${version.desktop.minVersion}` : "不限版本"}
          </span>
        </div>
        <Select value={version.version} onValueChange={setSelectedVersion}>
          <SelectTrigger className="w-36" aria-label="选择版本">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versions.map((entry) => (
              <SelectItem value={entry.version} key={entry.version}>
                v{entry.version}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {downloadError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription>{downloadError}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <h3 className="text-sm font-medium">更新说明</h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{version.changelog}</p>
      </div>

      {version.capabilities.length ? (
        <div>
          <h3 className="text-sm font-medium">能力声明</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {version.capabilities.map((capability) => (
              <Badge variant="secondary" className="font-mono" key={capability}>
                {capability}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>制品</TableHead>
              <TableHead>目标</TableHead>
              <TableHead>大小</TableHead>
              <TableHead className="text-right">下载</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {version.artifacts.map((artifact) => (
              <TableRow key={artifact.id}>
                <TableCell className="font-mono text-xs">{artifact.id}</TableCell>
                <TableCell>
                  {artifact.target.platform} / {artifact.target.arch}
                </TableCell>
                <TableCell>{formatBytes(artifact.size)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    disabled={downloading === artifact.id}
                    onClick={() => downloadArtifact(artifact.id)}
                    aria-label={`下载 ${artifact.id}`}
                    title="下载插件包"
                  >
                    {downloading === artifact.id ? <LoaderCircle className="animate-spin" /> : <Download />}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
