import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { XlsxDocumentPreviewView } from "../src/renderer/src/components/panel/files/xlsx-document-preview.tsx";
import type { XlsxDocumentPreview } from "../src/shared/office-document-contracts.ts";

const hooks = vi.hoisted(() => ({
  stateIndex: 0,
  refIndex: 0,
  states: [] as unknown[],
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<() => void | (() => void)>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      hooks.effects.push(effect);
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: <T,>(initial: T) => {
      const index = hooks.refIndex++;
      const existing = hooks.refs[index] as { current: T } | undefined;
      if (existing) return existing;
      const created = { current: initial };
      hooks.refs[index] = created;
      return created;
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = hooks.stateIndex++;
      if (index >= hooks.states.length)
        hooks.states[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      const setter = (value: T | ((current: T) => T)) => {
        const current = hooks.states[index] as T;
        hooks.states[index] = typeof value === "function" ? (value as (item: T) => T)(current) : value;
      };
      return [hooks.states[index] as T, setter] as const;
    },
  };
});

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [{ index: 0, start: 0 }],
    getTotalSize: () => 34,
  }),
}));

interface ElementProps {
  readonly children?: ReactNode;
  readonly onClick?: () => void;
}

function render(preview: XlsxDocumentPreview): ReactElement {
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  return XlsxDocumentPreviewView({ preview });
}

function findButton(node: ReactNode, text: string): ReactElement<ElementProps> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, text);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<ElementProps>(node)) return undefined;
  if (node.type === "button" && textContent(node.props.children) === text) return node;
  return findButton(node.props.children, text);
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return isValidElement<ElementProps>(node) ? textContent(node.props.children) : "";
}

function preview(revision: number): XlsxDocumentPreview {
  const cell = (sheet: string, value: string) => ({
    id: `${sheet}:A1`,
    address: "A1",
    value,
    valueSha256: `${sheet}-hash-${revision}`,
    valueType: "string" as const,
    editable: true,
  });
  return {
    kind: "xlsx",
    format: "xlsx",
    path: "reports/budget.xlsx",
    documentId: "xlsx-1",
    revision,
    sheets: [
      {
        id: "sheet:first",
        name: "First",
        rowCount: 1,
        columnCount: 1,
        cellCount: 1,
        truncated: false,
        cells: [cell("first", `First v${revision}`)],
      },
      {
        id: "sheet:second",
        name: "Second",
        rowCount: 1,
        columnCount: 1,
        cellCount: 1,
        truncated: false,
        cells: [cell("second", `Second v${revision}`)],
      },
    ],
  };
}

describe("XlsxDocumentPreviewView sheet state", () => {
  it("rejects an async cell response from a newer document revision", async () => {
    hooks.states = [];
    hooks.refs = [];
    const inspectOfficeDocument = vi.fn().mockResolvedValue({
      mode: "cells",
      documentId: "xlsx-1",
      path: "reports/budget.xlsx",
      revision: 2,
      warnings: [],
      truncated: false,
      sheets: [],
      cells: [
        {
          id: "first:A1",
          address: "A1",
          value: "New revision cell",
          valueSha256: "new-hash",
          valueType: "string",
          editable: true,
        },
      ],
    });
    vi.stubGlobal("window", {
      desktop: {
        files: {
          inspectOfficeDocument,
          onOfficeDocumentPlanCreated: vi.fn(() => () => undefined),
        },
      } as unknown as typeof window.desktop,
    });

    render(preview(1));
    for (const effect of hooks.effects) effect();
    await vi.waitFor(() => expect(inspectOfficeDocument).toHaveBeenCalled());
    await Promise.resolve();

    const afterResponse = textContent(render(preview(1)));
    expect(afterResponse).toContain("XLSX 文档版本已更新，请重新打开预览");
    expect(afterResponse).not.toContain("New revision cell");
  });

  it("does not carry the active sheet or loaded cells into a new revision", () => {
    hooks.states = [];
    hooks.refs = [];
    const firstRevision = render(preview(1));
    findButton(firstRevision, "Second")?.props.onClick?.();
    expect(textContent(render(preview(1)))).toContain("Second v1");

    const secondRevision = textContent(render(preview(2)));
    expect(secondRevision).toContain("First v2");
    expect(secondRevision).not.toContain("Second v2");
  });
});
