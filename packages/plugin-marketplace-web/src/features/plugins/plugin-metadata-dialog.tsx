import { CircleAlert, ImagePlus, LoaderCircle, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { getPluginIconUrl, type PublishPluginInput, type PublishPluginState } from "@/api.ts";
import { useUploadManagedIcon, useUpsertManagedPlugin } from "@/api-hooks.ts";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { errorMessage } from "@/lib/marketplace-ui.ts";
import { PluginAvatar } from "./plugin-avatar.tsx";
import { PluginFormField } from "./plugin-form-field.tsx";
import { splitList } from "./plugin-form-utils.ts";

export function PluginMetadataDialog({
  open,
  plugin,
  publisherIds,
  token,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  plugin?: PublishPluginState;
  publisherIds: string[];
  token: string;
  onOpenChange(open: boolean): void;
  onSaved(pluginId: string): void;
}) {
  const mutation = useUpsertManagedPlugin();
  const iconMutation = useUploadManagedIcon();
  const [pluginId, setPluginId] = useState("");
  const [publisherId, setPublisherId] = useState(publisherIds[0] ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [iconAssetId, setIconAssetId] = useState("");
  const [iconFile, setIconFile] = useState<File>();

  useEffect(() => {
    if (!open) return;
    setPluginId(plugin?.id ?? "");
    setPublisherId(plugin?.publisherId ?? publisherIds[0] ?? "");
    setName(plugin?.name ?? "");
    setDescription(plugin?.description ?? "");
    setCategories(plugin?.categories.join(", ") ?? "");
    setIconAssetId(plugin?.iconAssetId ?? "");
    setIconFile(undefined);
    mutation.reset();
    iconMutation.reset();
  }, [open, plugin, publisherIds, mutation.reset, iconMutation.reset]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const input: PublishPluginInput = {
      name: name.trim(),
      description: description.trim(),
      publisherId,
      categories: splitList(categories),
    };
    try {
      await mutation.mutateAsync({ pluginId: pluginId.trim(), input, token });
      onSaved(pluginId.trim());
    } catch {
      // Mutation state renders the error.
    }
  }

  async function uploadIcon(): Promise<void> {
    if (!pluginId.trim() || !iconFile) return;
    try {
      const result = await iconMutation.mutateAsync({ pluginId: pluginId.trim(), file: iconFile, token });
      setIconAssetId(result.iconAssetId);
      setIconFile(undefined);
    } catch {
      // Mutation state renders the error.
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{plugin ? "编辑插件资料" : "新建插件"}</DialogTitle>
          <DialogDescription>插件 ID 创建后不能更换发布者。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <PluginFormField label="插件 ID" htmlFor="plugin-id">
            <Input
              id="plugin-id"
              required
              maxLength={200}
              pattern="[a-z0-9]+(?:[._-][a-z0-9]+)+"
              placeholder="com.example.my-plugin"
              value={pluginId}
              disabled={!!plugin}
              onChange={(event) => setPluginId(event.target.value)}
            />
          </PluginFormField>
          <PluginFormField label="发布者" htmlFor="publisher-id">
            <Select value={publisherId} onValueChange={setPublisherId} disabled={!!plugin}>
              <SelectTrigger id="publisher-id" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {publisherIds.map((id) => (
                  <SelectItem value={id} key={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </PluginFormField>
          <PluginFormField label="名称" htmlFor="plugin-name">
            <Input
              id="plugin-name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </PluginFormField>
          <PluginFormField label="描述" htmlFor="plugin-description">
            <Textarea
              id="plugin-description"
              required
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </PluginFormField>
          <PluginFormField label="分类" htmlFor="plugin-categories" hint="用逗号分隔，最多 8 项">
            <Input
              id="plugin-categories"
              maxLength={320}
              placeholder="productivity, developer-tools"
              value={categories}
              onChange={(event) => setCategories(event.target.value)}
            />
          </PluginFormField>
          <PluginFormField
            label="插件图标"
            htmlFor="plugin-icon"
            hint={plugin ? "图标独立保存，不会创建新的插件版本。" : "先保存插件资料后才能上传独立图标。"}
          >
            <div className="flex items-center gap-3">
              <PluginAvatar
                name={name}
                iconUrl={pluginId ? getPluginIconUrl(pluginId, iconAssetId) : undefined}
                className="size-12 rounded-xl"
              />
              <div className="min-w-0 flex-1 space-y-2">
                <Input
                  id="plugin-icon"
                  type="file"
                  accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp,image/x-icon"
                  disabled={!plugin || iconMutation.isPending}
                  onChange={(event) => setIconFile(event.target.files?.[0])}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!plugin || !iconFile || iconMutation.isPending}
                  onClick={() => void uploadIcon()}
                >
                  {iconMutation.isPending ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
                  上传图标
                </Button>
              </div>
            </div>
          </PluginFormField>
          {iconMutation.isError ? (
            <Alert variant="destructive">
              <CircleAlert />
              <AlertDescription>{errorMessage(iconMutation.error)}</AlertDescription>
            </Alert>
          ) : null}
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
              {mutation.isPending ? <LoaderCircle className="animate-spin" /> : <Save />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
