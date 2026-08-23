import { useEffect, useState } from "react";
import { StructuredWidgetRow } from "./structured-widget-row.tsx";
import { StructuredWidgetStateIndicator } from "./structured-widget-state-indicator.tsx";

const CLOCK_INTERVAL_MS = 1_000;

export type StructuredWidgetState = "running" | "queued" | "success" | "warning" | "error" | "neutral";

export interface StructuredWidgetNode {
  id: string;
  label: string;
  status?: string;
  state: StructuredWidgetState;
  metadata: string[];
  children?: StructuredWidgetNode[];
}

export interface StructuredWidgetDocument {
  title: string;
  summary?: string;
  state: StructuredWidgetState;
  nodes: StructuredWidgetNode[];
  omitted?: string;
}

export interface StructuredWidgetSource {
  active: boolean;
  running: boolean;
  generatedAt: number;
  project(now: number): StructuredWidgetDocument;
}

export function StructuredWidget({ source }: { source: StructuredWidgetSource }) {
  const now = useWidgetClock(source);
  const document = source.project(now);
  return (
    <section className="composer-structured-widget" data-active={source.active || undefined}>
      <header className="composer-structured-widget-header">
        <span className="composer-structured-widget-heading">
          <StructuredWidgetStateIndicator state={document.state} />
          <strong>{document.title}</strong>
        </span>
        {document.summary ? <span className="composer-structured-widget-summary">{document.summary}</span> : null}
      </header>
      <div className="composer-structured-widget-rows" role="list">
        {document.nodes.map((node) => (
          <StructuredWidgetRow key={node.id} node={node} depth={0} />
        ))}
        {document.omitted ? <div className="composer-structured-widget-omitted">{document.omitted}</div> : null}
      </div>
    </section>
  );
}

function useWidgetClock(source: StructuredWidgetSource): number {
  const [now, setNow] = useState(source.generatedAt);
  useEffect(() => {
    if (!source.active) {
      setNow(source.generatedAt);
      return;
    }
    const update = () => setNow(Date.now());
    update();
    const interval = window.setInterval(update, CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [source]);
  return now;
}
