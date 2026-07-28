import { CircleAlert, LoaderCircle, Save } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import type { PublishPluginInput, PublishPluginState } from "@/api.ts";
import { useUpsertManagedPlugin } from "@/api-hooks.ts";
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
  const [pluginId, setPluginId] = useState("");
  const [publisherId, setPublisherId] = useState(publisherIds[0] ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState("");
  const [iconAssetId, setIconAssetId] = useState("");

  useEffect(() => {
    if (!open) return;
    setPluginId(plugin?.id ?? "");
    setPublisherId(plugin?.publisherId ?? publisherIds[0] ?? "");
    setName(plugin?.name ?? "");
    setDescription(plugin?.description ?? "");
    setCategories(plugin?.categories.join(", ") ?? "");
    setIconAssetId(plugin?.iconAssetId ?? "");
    mutation.reset();
  }, [open, plugin, publisherIds, mutation.reset]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const input: PublishPluginInput = {
      name: name.trim(),
      description: description.trim(),
      publisherId,
      categories: splitList(categories),
      ...(iconAssetId.trim() ? { iconAssetId: iconAssetId.trim() } : {}),
    };
    try {
      await mutation.mutateAsync({ pluginId: pluginId.trim(), input, token });
      onSaved(pluginId.trim());
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
          <PluginFormField label="图标资源 ID" htmlFor="plugin-icon" hint="可选">
            <Input
              id="plugin-icon"
              maxLength={128}
              value={iconAssetId}
              onChange={(event) => setIconAssetId(event.target.value)}
            />
          </PluginFormField>
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
