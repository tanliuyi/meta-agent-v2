import ExternalLink from "lucide-react/dist/esm/icons/external-link.mjs";
import Link from "lucide-react/dist/esm/icons/link.mjs";
import type { PiPluginSource } from "../../../../shared/contracts.ts";

export function SourcesBlock({ sources }: { sources: readonly PiPluginSource[] }) {
  if (sources.length === 0) return null;

  return (
    <section className="mt-1 border-t pt-3" aria-label="Sources">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link className="size-3.5" aria-hidden="true" />
        Sources
      </h3>
      <div className="flex flex-col gap-1">
        {sources.map((source, index) => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="group flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={source.url}
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-medium text-foreground">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{source.title?.trim() || source.url}</span>
            <span className="hidden max-w-[40%] truncate text-muted-foreground/70 sm:block">
              {sourceHost(source.url)}
            </span>
            <ExternalLink
              className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
              aria-hidden="true"
            />
          </a>
        ))}
      </div>
    </section>
  );
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
