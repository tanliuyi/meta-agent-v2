import { cn } from "@renderer/shared/lib/cn";
import { CommandGroup } from "@renderer/shared/ui/command-group";
import type { ComponentPropsWithoutRef } from "react";
import { getProviderIconSource } from "./model-selector-icons.tsx";
import { ProviderIcon } from "./provider-icon.tsx";

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<typeof CommandGroup> & {
  provider?: string;
};

export function ModelSelectorGroup({ className, provider, heading, ...props }: ModelSelectorGroupProps) {
  const providerKey = provider;
  const providerSource = providerKey ? getProviderIconSource(providerKey) : undefined;
  const groupHeading =
    providerSource && providerKey ? (
      <span className="flex items-center gap-1.5">
        <ProviderIcon provider={providerKey} />
        <span>{heading}</span>
      </span>
    ) : (
      heading
    );

  return (
    <CommandGroup
      data-slot="model-selector-group"
      heading={groupHeading}
      className={cn(
        "px-1 py-0.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-medium",
        className,
      )}
      {...props}
    />
  );
}
