import { Avatar, AvatarFallback } from "@/components/ui/avatar.tsx";
import { cn } from "@/lib/utils.ts";

export function PluginAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");

  return (
    <Avatar className={cn("size-9 rounded-md", className)}>
      <AvatarFallback className="rounded-md bg-primary/10 font-mono text-xs font-medium text-primary">
        {initials || "P"}
      </AvatarFallback>
    </Avatar>
  );
}
