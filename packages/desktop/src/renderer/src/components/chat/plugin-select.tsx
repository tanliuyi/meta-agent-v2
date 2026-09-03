import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useId, useState } from "react";
import type { DraftSelectablePlugin } from "../../../../shared/desktop-extension-contracts.ts";
import { marketplacePluginIconUrl } from "../../../../shared/plugin-icon-contracts.ts";
import { cn } from "../../shared/lib/cn.ts";
import { Checkbox } from "../../shared/ui/checkbox.tsx";
import { Popover } from "../../shared/ui/popover.tsx";
import { PopoverContent } from "../../shared/ui/popover-content.tsx";
import { PopoverTrigger } from "../../shared/ui/popover-trigger.tsx";
import { Tooltip } from "../../shared/ui/tooltip.tsx";
import { TooltipContent } from "../../shared/ui/tooltip-content.tsx";
import { TooltipTrigger } from "../../shared/ui/tooltip-trigger.tsx";
import { PluginIcon } from "./plugin-icon.tsx";

interface PluginSelectProps {
  plugins: readonly DraftSelectablePlugin[] | null;
  /** 会话级 direct-tool 插件激活子集；null 表示全部可用 direct-tool 插件。 */
  value: string[] | null;
  disabled?: boolean;
  loading?: boolean;
  onValueChange(enabledPluginIds: string[] | null): void;
}

/** 当前勾选态：继承（null）时项目开放插件全部勾选。 */
function isSelected(value: string[] | null, plugin: DraftSelectablePlugin): boolean {
  return value === null ? plugin.available : value.includes(plugin.id);
}

/** 勾选插件后的结果：与项目开放集合一致时回退到 null（继承项目级）。 */
function withPluginToggled(
  value: string[] | null,
  plugins: readonly DraftSelectablePlugin[],
  pluginId: string,
  checked: boolean,
): string[] | null {
  const availableIds = plugins.filter((plugin) => plugin.available).map((plugin) => plugin.id);
  if (checked) {
    const next = value === null ? [...availableIds] : [...value];
    if (!next.includes(pluginId)) next.push(pluginId);
    return equalIds(next, availableIds) ? null : next;
  }
  const next = value === null ? [...availableIds] : [...value];
  const filtered = next.filter((id) => id !== pluginId);
  return equalIds(filtered, availableIds) ? null : filtered;
}

function equalIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(right);
  return left.every((id) => set.has(id));
}

function pluginIconUrl(plugin: DraftSelectablePlugin): string | undefined {
  return plugin.source === "marketplace" ? marketplacePluginIconUrl(plugin.id) : undefined;
}

/** 新会话的 direct-tool 插件激活选择；plugin_call 插件由插件中心全局控制，不在此处显示。 */
export function PluginSelect({ plugins, value, disabled = false, loading = false, onValueChange }: PluginSelectProps) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const checkboxGroupId = useId();
  const allEnabled = value === null;
  const selectedPlugins = plugins?.filter((plugin) => isSelected(value, plugin)) ?? [];
  const enabledCount = selectedPlugins.length;

  const toggleAll = (checked: boolean) => {
    onValueChange(checked ? null : []);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setTooltipOpen(false);
      }}
    >
      <Tooltip
        open={tooltipOpen && !open}
        delayDuration={1000}
        onOpenChange={(next) => setTooltipOpen(open ? false : next)}
      >
        <TooltipTrigger asChild>
          <PopoverTrigger
            role="combobox"
            aria-haspopup="dialog"
            aria-label={loading ? "正在加载插件" : "插件"}
            aria-busy={loading || undefined}
            disabled={disabled || loading || plugins === null}
            className={cn(
              "group flex h-7 w-fit max-w-full items-center overflow-hidden rounded-xl px-1.5 text-xs font-medium whitespace-nowrap text-muted-foreground outline-none transition-[color,background-color,box-shadow]",
              "hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {loading && plugins === null ? (
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <>
                <span className="isolate flex -space-x-1" aria-hidden="true">
                  {selectedPlugins.slice(0, enabledCount > 3 ? 2 : 3).map((plugin, index) => (
                    <span
                      key={plugin.id}
                      className={cn(
                        "relative flex size-[22px] aspect-square shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/95 shadow-sm",
                        enabledCount > 1 ? "ring-2 ring-(--composer-background)" : undefined,
                        index === 0 ? "z-10" : index === 1 ? "z-20" : "z-30",
                      )}
                    >
                      <PluginIcon name={plugin.displayName} iconUrl={pluginIconUrl(plugin)} className="size-5" />
                    </span>
                  ))}
                  {enabledCount > 3 ? (
                    <span className="relative z-30 flex size-[22px] aspect-square shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground shadow-sm ring-2 ring-(--composer-background)">
                      {enabledCount}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">选择插件</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" sideOffset={6} className="z-(--stack-menu) w-64 overflow-hidden rounded-lg p-0">
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <span className="text-xs font-semibold text-foreground">插件</span>
          {plugins && plugins.length > 0 ? (
            <div className="flex items-center gap-2.5">
              <span className="text-[10px] tabular-nums text-muted-foreground">
                已选 {enabledCount}/{plugins.length}
              </span>
              <span className="h-3 w-px bg-border/70" aria-hidden="true" />
              <div className="flex items-center gap-1.5">
                <Checkbox
                  id={`${checkboxGroupId}-all`}
                  checked={allEnabled}
                  className="size-3.5 rounded-[3px] [&_svg]:size-3"
                  onCheckedChange={(next) => toggleAll(next === true)}
                />
                <label
                  htmlFor={`${checkboxGroupId}-all`}
                  className="cursor-default text-[10px] text-muted-foreground select-none"
                >
                  全部启用
                </label>
              </div>
            </div>
          ) : null}
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {plugins === null ? (
            <div className="flex items-center gap-2 px-2.5 py-4 text-xs text-muted-foreground" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              正在加载插件…
            </div>
          ) : plugins.length === 0 ? (
            <div className="px-2.5 py-4 text-xs text-muted-foreground">没有可选的插件</div>
          ) : (
            plugins.map((plugin) => {
              const checked = isSelected(value, plugin);
              const checkboxId = `${checkboxGroupId}-${plugin.id}`;
              return (
                <div
                  key={plugin.id}
                  className="flex min-h-8 items-center gap-2 rounded-md px-2 transition-colors hover:bg-accent focus-within:bg-accent"
                >
                  <Checkbox
                    id={checkboxId}
                    checked={checked}
                    className="size-3.5 rounded-[3px] [&_svg]:size-3"
                    onCheckedChange={(next) =>
                      onValueChange(withPluginToggled(value, plugins, plugin.id, next === true))
                    }
                  />
                  <span className="flex size-[20px] aspect-square shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted/95 shadow-sm">
                    <PluginIcon name={plugin.displayName} iconUrl={pluginIconUrl(plugin)} className="size-[18px]" />
                  </span>
                  <label
                    htmlFor={checkboxId}
                    className="flex min-w-0 flex-1 cursor-default items-center gap-1.5 self-stretch text-xs select-none"
                  >
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate",
                        !plugin.available && !checked ? "text-muted-foreground" : undefined,
                      )}
                    >
                      {plugin.displayName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 text-[10px] font-normal text-muted-foreground",
                        !plugin.available ? "text-muted-foreground/70" : undefined,
                      )}
                      title={!plugin.available ? "该项目未开放此插件，启用后仅本会话加载" : undefined}
                    >
                      {!plugin.available ? "未开放" : plugin.source === "marketplace" ? "市场" : "本地"}
                    </span>
                  </label>
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
