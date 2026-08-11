import { cn } from "@renderer/shared/lib/cn";
import { ModelIconImage } from "./model-icon-image.tsx";
import { getProviderIconSource } from "./model-selector-icons.tsx";

export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  const source = getProviderIconSource(provider);
  return source ? <ModelIconImage src={source} className={cn("size-3.5", className)} /> : null;
}
