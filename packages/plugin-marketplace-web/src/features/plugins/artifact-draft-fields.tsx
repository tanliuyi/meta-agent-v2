import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PluginFormField } from "./plugin-form-field.tsx";
import type { ArtifactDraft } from "./plugin-form-utils.ts";

export function ArtifactDraftFields({
  artifacts,
  onUpdate,
  onRemove,
  onAdd,
}: {
  artifacts: ArtifactDraft[];
  onUpdate(key: number, patch: Partial<ArtifactDraft>): void;
  onRemove(key: number): void;
  onAdd(): void;
}) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-medium">制品</legend>
      {artifacts.map((artifact, index) => (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4" key={artifact.key}>
          <div className="flex items-center justify-between">
            <strong className="text-sm font-medium">制品 {index + 1}</strong>
            {artifacts.length > 1 ? (
              <Button
                variant="ghost"
                size="icon"
                type="button"
                onClick={() => onRemove(artifact.key)}
                aria-label={`移除制品 ${index + 1}`}
                title="移除制品"
              >
                <Trash2 className="text-destructive" />
              </Button>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <PluginFormField label="制品 ID" htmlFor={`artifact-id-${artifact.key}`}>
              <Input
                id={`artifact-id-${artifact.key}`}
                required
                maxLength={128}
                value={artifact.id}
                onChange={(event) => onUpdate(artifact.key, { id: event.target.value })}
              />
            </PluginFormField>
            <PluginFormField label="入口文件" htmlFor={`artifact-entry-${artifact.key}`}>
              <Input
                id={`artifact-entry-${artifact.key}`}
                required
                maxLength={256}
                value={artifact.entry}
                onChange={(event) => onUpdate(artifact.key, { entry: event.target.value })}
              />
            </PluginFormField>
            <PluginFormField label="平台" htmlFor={`artifact-platform-${artifact.key}`}>
              <Input
                id={`artifact-platform-${artifact.key}`}
                required
                value={artifact.platform}
                onChange={(event) => onUpdate(artifact.key, { platform: event.target.value })}
              />
            </PluginFormField>
            <PluginFormField label="架构" htmlFor={`artifact-arch-${artifact.key}`}>
              <Input
                id={`artifact-arch-${artifact.key}`}
                required
                value={artifact.arch}
                onChange={(event) => onUpdate(artifact.key, { arch: event.target.value })}
              />
            </PluginFormField>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`artifact-preferred-${artifact.key}`}
              checked={artifact.preferred}
              onCheckedChange={(checked) => onUpdate(artifact.key, { preferred: checked === true })}
            />
            <Label htmlFor={`artifact-preferred-${artifact.key}`}>首选制品</Label>
          </div>
        </div>
      ))}
      <Button variant="outline" size="sm" type="button" className="w-fit" onClick={onAdd}>
        <Plus />
        添加制品
      </Button>
    </fieldset>
  );
}
