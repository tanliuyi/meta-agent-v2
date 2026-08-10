import { Select } from "@renderer/components/assistant-ui/select/select";
import { Button } from "@renderer/shared/ui/button";
import { Input } from "@renderer/shared/ui/input";
import { Switch } from "@renderer/shared/ui/switch";
import { Textarea } from "@renderer/shared/ui/textarea";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.mjs";
import type { ChangeEvent } from "react";
import type { PluginConfigurationField } from "../../../../shared/plugin-configuration-contracts.ts";
import { PluginConfigurationFieldLabelRow } from "./plugin-configuration-field-label-row.tsx";
import { PluginConfigurationModelSelector } from "./plugin-configuration-model-selector.tsx";
import type { PluginConfigurationController } from "./use-plugin-configuration.ts";

export function PluginConfigurationFieldControl({
  field,
  controller,
}: {
  field: PluginConfigurationField;
  controller: PluginConfigurationController;
}) {
  const id = `plugin-configuration-${field.key}`;
  const error = controller.fieldErrors.get(field.key);
  if (field.widget === "model-selector") {
    return <PluginConfigurationModelSelector field={field} controller={controller} />;
  }
  const descriptionId = field.description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;
  if (field.type === "boolean") {
    return (
      <div className="plugin-configuration-toggle-field" data-deprecated={field.deprecated ? "true" : undefined}>
        <div>
          <PluginConfigurationFieldLabelRow id={id} field={field} controller={controller} />
          {field.description ? <span id={descriptionId}>{field.description}</span> : null}
          {error ? (
            <span id={errorId} className="plugin-configuration-field-error">
              {error}
            </span>
          ) : null}
        </div>
        <Switch
          id={id}
          checked={controller.values[field.key] === true}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onCheckedChange={(checked) => controller.setValue(field.key, checked)}
        />
      </div>
    );
  }
  if (field.type === "secret") {
    const configured = controller.snapshot?.secrets[field.key] === true && !controller.clearedSecrets.has(field.key);
    return (
      <div className="plugin-configuration-field" data-deprecated={field.deprecated ? "true" : undefined}>
        <div className="plugin-configuration-label-row">
          <label htmlFor={id}>{field.label}</label>
          {field.deprecated ? <span className="plugin-configuration-deprecated-badge">已弃用</span> : null}
          {field.deprecatedMessage ? (
            <span className="plugin-configuration-deprecated-message">{field.deprecatedMessage}</span>
          ) : null}
          <span className="plugin-configuration-field-status">{configured ? "已配置" : "未配置"}</span>
        </div>
        {field.description ? <span id={descriptionId}>{field.description}</span> : null}
        <div className="plugin-configuration-secret-row">
          <Input
            id={id}
            type="password"
            value={controller.secretValues[field.key] ?? ""}
            placeholder={configured ? "输入新值以替换" : field.placeholder}
            minLength={field.minLength}
            maxLength={field.maxLength}
            pattern={field.pattern}
            disabled={!controller.snapshot?.secretStorageAvailable}
            autoComplete="new-password"
            aria-describedby={describedBy}
            aria-invalid={error ? true : undefined}
            onChange={(event) => controller.setSecretValue(field.key, event.currentTarget.value)}
          />
          {configured ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`清除${field.label}`}
              title="清除"
              onClick={() => controller.clearSecret(field.key)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
        {!controller.snapshot?.secretStorageAvailable ? (
          <span className="plugin-configuration-field-error">系统凭据加密当前不可用</span>
        ) : null}
        {error ? (
          <span id={errorId} className="plugin-configuration-field-error">
            {error}
          </span>
        ) : null}
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <div className="plugin-configuration-field" data-deprecated={field.deprecated ? "true" : undefined}>
        <PluginConfigurationFieldLabelRow id={id} labelId={`${id}-label`} field={field} controller={controller} />
        {field.description ? <span id={descriptionId}>{field.description}</span> : null}
        <Select
          className="plugin-configuration-select"
          id={id}
          value={String(controller.values[field.key] ?? "")}
          options={field.options}
          placeholder="选择一个选项"
          aria-labelledby={`${id}-label`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onValueChange={(value) => controller.setValue(field.key, value)}
        />
        {error ? (
          <span id={errorId} className="plugin-configuration-field-error">
            {error}
          </span>
        ) : null}
      </div>
    );
  }
  const common = {
    id,
    value: String(controller.values[field.key] ?? ""),
    placeholder: field.type === "number" ? undefined : field.placeholder,
    pattern: field.type === "textarea" || field.type === "number" ? undefined : field.pattern,
    minLength: field.type === "number" ? undefined : field.minLength,
    maxLength: field.type === "number" ? undefined : field.maxLength,
    required: field.required,
    "aria-describedby": describedBy,
    "aria-invalid": error ? (true as const) : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      controller.setValue(field.key, event.currentTarget.value),
  };
  return (
    <div className="plugin-configuration-field" data-deprecated={field.deprecated ? "true" : undefined}>
      <PluginConfigurationFieldLabelRow id={id} field={field} controller={controller} />
      {field.description ? <span id={descriptionId}>{field.description}</span> : null}
      {field.type === "textarea" ? (
        <Textarea {...common} />
      ) : (
        <Input
          {...common}
          type={field.type === "number" ? "number" : "text"}
          min={field.type === "number" ? field.minimum : undefined}
          max={field.type === "number" ? field.maximum : undefined}
          step={field.type === "number" ? field.step : undefined}
          spellCheck={field.type === "path" ? false : undefined}
        />
      )}
      {error ? (
        <span id={errorId} className="plugin-configuration-field-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
