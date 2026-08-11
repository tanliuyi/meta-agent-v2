import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.tsx";
import { cn } from "@/lib/utils.ts";

export function PluginAvatar({ name, iconUrl, className }: { name: string; iconUrl?: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

  return (
    <Avatar className={cn("size-9 rounded-xl", className)}>
      {iconUrl ? <AvatarImage src={iconUrl} alt="" /> : null}
      <AvatarFallback className="rounded-xl bg-primary/10 font-mono text-xs font-medium text-primary">
        {initials || "P"}
      </AvatarFallback>
    </Avatar>
  );
}
