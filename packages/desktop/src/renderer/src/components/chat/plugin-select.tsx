import Blocks from "lucide-react/dist/esm/icons/blocks.mjs";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { useState } from "react";
import type { DraftSelectablePlugin } from "../../../../shared/desktop-extension-contracts.ts";
import { cn } from "../../shared/lib/cn.ts";
import { Checkbox } from "../../shared/ui/checkbox.tsx";
import { Popover } from "../../shared/ui/popover.tsx";
import { PopoverContent } from "../../shared/ui/popover-content.tsx";
import { PopoverTrigger } from "../../shared/ui/popover-trigger.tsx";
import { Tooltip } from "../../shared/ui/tooltip.tsx";
import { TooltipContent } from "../../shared/ui/tooltip-content.tsx";
import { TooltipTrigger } from "../../shared/ui/tooltip-trigger.tsx";

interface PluginSelectProps {
  plugins: readonly DraftSelectablePlugin[] | null;
  /** 会话级激活子集；null 表示继承项目级（仅项目开放的插件）。 */
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

/** 新会话草稿的插件激活选择：默认继承项目级作用域，项目未开放的插件也可在本会话单独启用。 */
export function PluginSelect({ plugins, value, disabled = false, loading = false, onValueChange }: PluginSelectProps) {
  const [open, setOpen] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const allEnabled = value === null;
  const enabledCount = allEnabled ? (plugins?.filter((plugin) => plugin.available).length ?? 0) : (value?.length ?? 0);

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
            aria-label={loading ? "正在加载插件" : "选择会话插件"}
            aria-busy={loading || undefined}
            disabled={disabled || loading || plugins === null}
            className={cn(
              "flex w-fit max-w-full items-center justify-between gap-1.5 overflow-hidden rounded-xl text-xs whitespace-nowrap text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
              "h-7 px-2 py-1 hover:bg-muted hover:text-muted-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
            )}
          >
            <Blocks aria-hidden="true" />
            {loading && plugins === null ? (
              <span className="flex min-w-0 items-center gap-1.5" role="status">
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
                <span>加载插件</span>
              </span>
            ) : (
              <span className="min-w-0 truncate">
                插件
                {plugins && plugins.length > 0 ? (
                  <span className="text-muted-foreground/70">
                    {" "}
                    · {allEnabled ? "全部" : `${enabledCount}/${plugins.length}`}
                  </span>
                ) : null}
              </span>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">选择会话插件</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" sideOffset={6} className="w-72 p-0">
        <div className="border-b border-border/60 px-3 py-2.5">
          <div className="text-sm font-medium">会话插件</div>
          <div className="mt-0.5 text-xs text-muted-foreground">默认继承项目作用域；项目未开放的插件可在此单独启用</div>
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {plugins === null ? (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground" role="status">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              正在加载插件…
            </div>
          ) : plugins.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">没有可选的插件</div>
          ) : (
            <>
              <button
                type="button"
                role="checkbox"
                aria-checked={allEnabled}
                className="flex w-full cursor-default items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                onClick={() => toggleAll(!allEnabled)}
              >
                <Checkbox checked={allEnabled} onCheckedChange={(next) => toggleAll(next === true)} tabIndex={-1} />
                <span className="min-w-0 flex-1 truncate text-left">全部激活</span>
                <span className="shrink-0 text-xs text-muted-foreground">{plugins.length}</span>
              </button>
              <div role="separator" className="mx-1 my-1 h-px bg-border/60" />
              {plugins.map((plugin) => {
                const checked = isSelected(value, plugin);
                return (
                  <button
                    key={plugin.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    className="flex w-full cursor-default items-center gap-2 rounded-xl px-2 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onValueChange(withPluginToggled(value, plugins, plugin.id, !checked))}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) =>
                        onValueChange(withPluginToggled(value, plugins, plugin.id, next === true))
                      }
                      tabIndex={-1}
                    />
                    <span
                      className={cn(
                        "min-w-0 flex-1 truncate text-left",
                        !plugin.available && !checked ? "text-muted-foreground" : undefined,
                      )}
                    >
                      {plugin.displayName}
                    </span>
                    {!plugin.available ? (
                      <span
                        className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title="该项目未开放此插件，启用后仅本会话加载"
                      >
                        项目未开放
                      </span>
                    ) : (
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {plugin.source === "marketplace" ? "市场" : "本地"}
                      </span>
                    )}
                  </button>
                );
              })}
            </>
          )}
        </div>
        <div className="border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          {allEnabled ? "跟随项目设置（项目已开启的插件全部使用）" : `已开启 ${enabledCount}/${plugins?.length ?? 0}`}
        </div>
      </PopoverContent>
    </Popover>
  );
}
