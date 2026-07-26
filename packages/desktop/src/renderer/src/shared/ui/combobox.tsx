import { cn } from "@renderer/shared/lib/cn";
import { useMemo, useRef, useState } from "react";
import { Command } from "./command.tsx";
import { CommandEmpty } from "./command-empty.tsx";
import { CommandGroup } from "./command-group.tsx";
import { CommandInput } from "./command-input.tsx";
import { CommandItem } from "./command-item.tsx";
import { CommandList } from "./command-list.tsx";
import { Popover } from "./popover.tsx";
import { PopoverContent } from "./popover-content.tsx";
import { PopoverTrigger } from "./popover-trigger.tsx";

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  value: string;
  options: readonly ComboboxOption[];
  placeholder?: string;
  emptyText?: string;
  className?: string;
  onValueChange(value: string): void;
}

/**
 * Autocomplete input combobox. Wraps cmdk Command inside a Popover
 * to provide a searchable suggestion list as the user types.
 */
export function Combobox({
  value,
  options,
  placeholder,
  emptyText = "无匹配",
  className,
  onValueChange,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const query = currentCsvToken(value).toLowerCase();
    return query ? options.filter((option) => option.label.toLowerCase().includes(query)) : options;
  }, [value, options]);

  function select(optionValue: string): void {
    onValueChange(replaceCurrentCsvToken(value, optionValue));
    setOpen(false);
    inputRef.current?.focus();
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={cn(
            "border-input bg-background ring-offset-background flex h-(--control-height-input) w-full cursor-text items-center rounded-[0.625rem] border px-3 text-sm focus-within:outline-none focus-within:ring-2 focus-within:ring-ring",
            className,
          )}
          onClick={() => setOpen(true)}
        >
          <input
            ref={inputRef}
            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            placeholder={placeholder}
            value={value}
            onChange={(event) => {
              onValueChange(event.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) p-0"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false}>
          <CommandInput placeholder="搜索..." value={value} onValueChange={onValueChange} className="h-8" />
          <CommandList>
            {filtered.length === 0 ? (
              <CommandEmpty>{emptyText}</CommandEmpty>
            ) : (
              <CommandGroup>
                {filtered.map((option) => (
                  <CommandItem key={option.value} value={option.value} onSelect={() => select(option.value)}>
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function currentCsvToken(value: string): string {
  return value.slice(value.lastIndexOf(",") + 1).trim();
}

export function replaceCurrentCsvToken(value: string, optionValue: string): string {
  const prefix = value.slice(0, value.lastIndexOf(",") + 1);
  const entries = [
    ...new Set(
      `${prefix}${optionValue}`
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  return entries.join(", ");
}
