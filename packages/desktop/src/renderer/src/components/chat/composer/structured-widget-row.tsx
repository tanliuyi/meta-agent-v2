import { type CSSProperties, Fragment } from "react";
import type { StructuredWidgetNode } from "./structured-widget.tsx";
import { StructuredWidgetStateIndicator } from "./structured-widget-state-indicator.tsx";

export function StructuredWidgetRow({ node, depth }: { node: StructuredWidgetNode; depth: number }) {
  return (
    <Fragment>
      <div
        className="composer-structured-widget-row"
        data-depth={depth}
        role="listitem"
        style={{ "--structured-widget-depth": depth } as CSSProperties}
      >
        <span className="composer-structured-widget-indent" aria-hidden="true" />
        <span className="composer-structured-widget-branch" aria-hidden="true" />
        <span className="composer-structured-widget-identity">
          <strong className="composer-structured-widget-label">{node.label}</strong>
          {node.status ? (
            <span className="composer-structured-widget-state">
              <StructuredWidgetStateIndicator state={node.state} compact />
              <span className="composer-structured-widget-status" data-state={node.state}>
                {node.status}
              </span>
            </span>
          ) : null}
        </span>
        {node.metadata.length > 0 ? (
          <span className="composer-structured-widget-metadata">
            {node.metadata.map((item, index) => (
              <span key={`${index}:${item}`}>{item}</span>
            ))}
          </span>
        ) : null}
      </div>
      {node.children?.map((child) => (
        <StructuredWidgetRow key={child.id} node={child} depth={depth + 1} />
      ))}
    </Fragment>
  );
}
