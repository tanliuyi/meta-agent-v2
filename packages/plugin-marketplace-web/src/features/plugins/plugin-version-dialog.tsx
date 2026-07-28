import { CircleAlert, LoaderCircle, Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { PublishArtifactInput, PublishVersionInput } from "@/api.ts";
import { useCreateManagedVersion } from "@/api-hooks.ts";
import { Alert, AlertDescription } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";
import { ArtifactDraftFields } from "./artifact-draft-fields.tsx";
import { PluginFormField } from "./plugin-form-field.tsx";
import { type ArtifactDraft, createArtifactDraft, splitList } from "./plugin-form-utils.ts";

export function PluginVersionDialog({
  open,
  pluginId,
  token,
  onOpenChange,
}: {
  open: boolean;
  pluginId: string;
  token: string;
  onOpenChange(open: boolean): void;
}) {
  const mutation = useCreateManagedVersion();
  const [version, setVersion] = useState("");
  const [changelog, setChangelog] = useState("");
  const [hostProfileVersion, setHostProfileVersion] = useState("1");
  const [minVersion, setMinVersion] = useState("");
  const [maxVersionExclusive, setMaxVersionExclusive] = useState("");
  const [capabilities, setCapabilities] = useState("");
  const [nextArtifactKey, setNextArtifactKey] = useState(1);
  const [artifacts, setArtifacts] = useState<ArtifactDraft[]>([createArtifactDraft(0)]);

  useEffect(() => {
    if (!open) return;
    setVersion("");
    setChangelog("");
    setHostProfileVersion("1");
    setMinVersion("");
    setMaxVersionExclusive("");
    setCapabilities("");
    setNextArtifactKey(1);
    setArtifacts([createArtifactDraft(0)]);
    mutation.reset();
  }, [open, mutation.reset]);

  function updateArtifact(key: number, patch: Partial<ArtifactDraft>): void {
    setArtifacts((current) => current.map((artifact) => (artifact.key === key ? { ...artifact, ...patch } : artifact)));
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const artifactInputs: PublishArtifactInput[] = artifacts.map((artifact) => ({
      id: artifact.id.trim(),
      entry: artifact.entry.trim(),
      target: { platform: artifact.platform.trim(), arch: artifact.arch.trim() },
      containsNativeCode: false,
      preferred: artifact.preferred,
    }));
    const input: PublishVersionInput = {
      version: version.trim(),
      changelog: changelog.trim(),
      desktop: {
        hostProfileVersion: Number(hostProfileVersion),
        ...(minVersion.trim() ? { minVersion: minVersion.trim() } : {}),
        ...(maxVersionExclusive.trim() ? { maxVersionExclusive: maxVersionExclusive.trim() } : {}),
      },
      capabilities: splitList(capabilities),
      artifacts: artifactInputs,
    };
    try {
      await mutation.mutateAsync({ pluginId, input, token });
      onOpenChange(false);
    } catch {
      // Mutation state renders the error.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建版本草稿</DialogTitle>
          <DialogDescription>声明兼容性和制品后，再在版本列表上传对应 ZIP。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-5" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <PluginFormField label="版本" htmlFor="version-number">
              <Input
                id="version-number"
                required
                maxLength={64}
                placeholder="1.0.0"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              />
            </PluginFormField>
            <PluginFormField label="Host Profile" htmlFor="host-profile">
              <Input
                id="host-profile"
                required
                type="number"
                min={1}
                max={1000}
                value={hostProfileVersion}
                onChange={(event) => setHostProfileVersion(event.target.value)}
              />
            </PluginFormField>
          </div>
          <PluginFormField label="更新说明" htmlFor="version-changelog">
            <Textarea
              id="version-changelog"
              required
              maxLength={4000}
              value={changelog}
              onChange={(event) => setChangelog(event.target.value)}
            />
          </PluginFormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <PluginFormField label="最低 Desktop 版本" htmlFor="min-desktop-version" hint="可选">
              <Input
                id="min-desktop-version"
                placeholder="0.0.31"
                value={minVersion}
                onChange={(event) => setMinVersion(event.target.value)}
              />
            </PluginFormField>
            <PluginFormField label="最高版本（不含）" htmlFor="max-desktop-version" hint="可选">
              <Input
                id="max-desktop-version"
                placeholder="0.1.0"
                value={maxVersionExclusive}
                onChange={(event) => setMaxVersionExclusive(event.target.value)}
              />
            </PluginFormField>
          </div>
          <PluginFormField label="能力声明" htmlFor="version-capabilities" hint="用逗号分隔">
            <Input
              id="version-capabilities"
              placeholder="tools.register, events.subscribe"
              value={capabilities}
              onChange={(event) => setCapabilities(event.target.value)}
            />
          </PluginFormField>

          <Separator />
          <ArtifactDraftFields
            artifacts={artifacts}
            onUpdate={updateArtifact}
            onRemove={(key) => setArtifacts((current) => current.filter((artifact) => artifact.key !== key))}
            onAdd={() => {
              setArtifacts((current) => [...current, createArtifactDraft(nextArtifactKey)]);
              setNextArtifactKey((value) => value + 1);
            }}
          />

          {mutation.isError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{errorMessage(mutation.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Plus />}
              创建草稿
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
