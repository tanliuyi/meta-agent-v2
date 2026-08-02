import { Button } from "@renderer/shared/ui/button";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.mjs";
import type { PluginConfigurationField } from "../../../../shared/plugin-configuration-contracts.ts";
import type { PluginConfigurationController } from "./use-plugin-configuration.ts";

export function PluginConfigurationFieldLabelRow({
  id,
  field,
  controller,
  labelId,
}: {
  id: string;
  field: PluginConfigurationField;
  controller: PluginConfigurationController;
  labelId?: string;
}) {
  const resetLabel = `恢复${field.label}的默认值`;
  return (
    <div className="plugin-configuration-label-row">
      <label id={labelId} htmlFor={labelId === undefined ? id : undefined}>
        {field.label}
      </label>
      {field.deprecated ? <span className="plugin-configuration-deprecated-badge">已弃用</span> : null}
      {field.deprecatedMessage ? (
        <span className="plugin-configuration-deprecated-message">{field.deprecatedMessage}</span>
      ) : null}
      {hasResetDefault(field, controller) ? (
        <Button
          variant="ghost"
          size="icon"
          className="plugin-configuration-reset-button"
          aria-label={resetLabel}
          title={resetLabel}
          onClick={() => controller.resetField(field.key)}
        >
          <RotateCcw />
        </Button>
      ) : null}
    </div>
  );
}

function hasResetDefault(field: PluginConfigurationField, controller: PluginConfigurationController): boolean {
  if (field.type === "secret" || field.defaultValue === undefined) return false;
  const draft = controller.values[field.key];
  return field.type === "boolean" ? draft !== field.defaultValue : String(draft ?? "") !== String(field.defaultValue);
}
