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
    const mainMessage = messageNode("main-message");
    const sideMessage = messageNode("side-message");
    const mainRoot = rootContaining(mainMessage);
    const sideRoot = rootContaining(sideMessage);

    expect(readSelectionInfo(selectionFor(mainMessage), mainRoot)).toMatchObject({
      text: "selected text",
      messageId: "main-message",
    });
    expect(readSelectionInfo(selectionFor(mainMessage), sideRoot)).toBeNull();
  });
});

function messageNode(messageId: string): Node {
  return {
    nodeType: 1,
    parentElement: null,
    getAttribute: (name: string) => (name === "data-message-id" ? messageId : null),
  } as unknown as Node;
}

function rootContaining(message: Node): HTMLElement {
  return { contains: (node: Node | null) => node === message } as unknown as HTMLElement;
}
