import { describe, expect, it } from "vitest";
import { readSelectionInfo } from "../src/renderer/src/components/chat/selection-toolbar.tsx";

function selectionFor(anchorNode: Node, focusNode: Node = anchorNode): Selection {
  return {
    anchorNode,
    focusNode,
    isCollapsed: false,
    toString: () => "selected text",
    getRangeAt: () => ({ getBoundingClientRect: () => ({ top: 10, left: 20, width: 30 }) as DOMRect }) as Range,
  } as unknown as Selection;
}

describe("selection toolbar scope", () => {
  it("only accepts a selection contained by its own thread root", () => {
    const mainMessage = messageNode("main-message", true);
    const sideMessage = messageNode("side-message", true);
    const mainRoot = rootContaining(mainMessage);
    const sideRoot = rootContaining(sideMessage);

    expect(readSelectionInfo(selectionFor(mainMessage), mainRoot)).toMatchObject({
      text: "selected text",
      messageId: "main-message",
    });
    expect(readSelectionInfo(selectionFor(mainMessage), sideRoot)).toBeNull();
  });

  it("rejects selections outside quote-selectable regions", () => {
    const selectable = messageNode("main-message", true);
    const notSelectable = messageNode("main-message", false);
    const root = rootContaining(selectable, notSelectable);

    expect(readSelectionInfo(selectionFor(selectable), root)).toMatchObject({
      text: "selected text",
      messageId: "main-message",
    });
    expect(readSelectionInfo(selectionFor(notSelectable), root)).toBeNull();
    // 锚点或焦点任一落在不可引用区域（如工具调用、reasoning）都不显示工具栏
    expect(readSelectionInfo(selectionFor(selectable, notSelectable), root)).toBeNull();
  });
});

function messageNode(messageId: string, quoteSelectable: boolean): Node {
  return {
    nodeType: 1,
    parentElement: null,
    getAttribute: (name: string) =>
      name === "data-message-id" ? messageId : name === "data-aui-quote-selectable" && quoteSelectable ? "" : null,
    closest: (selector: string) =>
      selector === "[data-aui-quote-selectable]" && quoteSelectable ? ({ closest: () => null } as Element) : null,
  } as unknown as Node;
}

function rootContaining(...messages: Node[]): HTMLElement {
  return { contains: (node: Node | null) => messages.includes(node!) } as unknown as HTMLElement;
}
