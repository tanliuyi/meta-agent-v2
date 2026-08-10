import { cn } from "../../shared/lib/cn.ts";

const PLUGIN_ICON_TONES = [
  "bg-primary/8 text-primary/70",
  "bg-secondary/80 text-secondary-foreground/70",
  "bg-accent/80 text-accent-foreground/70",
  "bg-muted text-muted-foreground/80",
  "bg-destructive/8 text-destructive/65",
  "bg-foreground/8 text-foreground/65",
] as const;

interface PluginIconProps {
  name: string;
}

/** Stable initials and semantic color generated from a plugin display name. */
export function PluginIcon({ name }: PluginIconProps) {
  const label = [...name.trim()][0] ?? "?";
  const toneIndex = [...name].reduce((hash, character) => hash + (character.codePointAt(0) ?? 0), 0);

  return (
    <span
      className={cn(
        "flex size-[18px] aspect-square shrink-0 items-center justify-center rounded-full text-[9px] font-semibold leading-none tracking-normal uppercase shadow-xs",
        PLUGIN_ICON_TONES[toneIndex % PLUGIN_ICON_TONES.length],
      )}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
