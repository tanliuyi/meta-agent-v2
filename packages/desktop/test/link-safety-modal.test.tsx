import React, { type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@renderer/shared/ui/button", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => <button {...props}>{children}</button>,
}));
vi.mock("@renderer/shared/ui/dialog", () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open: boolean }) => (open ? <div>{children}</div> : null),
}));
vi.mock("@renderer/shared/ui/dialog-close", () => ({
  DialogClose: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@renderer/shared/ui/dialog-content", () => ({
  DialogContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@renderer/shared/ui/dialog-description", () => ({
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("@renderer/shared/ui/dialog-footer", () => ({
  DialogFooter: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@renderer/shared/ui/dialog-title", () => ({
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useOpenWorkbenchFileInPanel: () => vi.fn(),
  useSessionScope: () => ({ record: { identity: { projectId: "project-1" } } }),
}));

import {
  isLocalFileLink,
  LinkSafetyModal,
} from "../src/renderer/src/components/assistant-ui/streamdown/link-safety-modal.tsx";

describe("LinkSafetyModal", () => {
  it.each([
    "/workspace/src/app.tsx:12",
    "packages/desktop/src/main/ipc.ts:941",
    "../shared/contracts.ts",
    "file:///workspace/src/app.tsx#L12",
    "C:\\workspace\\src\\app.tsx:12",
  ])("recognizes local file link: %s", (url) => {
    expect(isLocalFileLink(url)).toBe(true);
  });

  it.each(["https://example.com", "mailto:test@example.com", "#heading", "//example.com/file"])(
    "preserves link safety for non-file link: %s",
    (url) => {
      expect(isLocalFileLink(url)).toBe(false);
    },
  );

  it("does not render the external-link dialog for a project file", () => {
    const markup = renderToStaticMarkup(
      <LinkSafetyModal
        isOpen
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        url="/workspace/packages/desktop/src/main/ipc.ts:941"
      />,
    );

    expect(markup).toBe("");
  });

  it("keeps the confirmation dialog for external links", () => {
    const markup = renderToStaticMarkup(
      <LinkSafetyModal isOpen onClose={vi.fn()} onConfirm={vi.fn()} url="https://example.com" />,
    );

    expect(markup).toContain("打开外部链接？");
    expect(markup).toContain("https://example.com");
  });
});
