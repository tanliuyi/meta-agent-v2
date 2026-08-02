import { createContext, type PropsWithChildren, useContext } from "react";

type ReferenceMarkdownImage = (markdown: string) => void;

const MarkdownImageReferenceContext = createContext<ReferenceMarkdownImage | null>(null);

export function MarkdownImageReferenceProvider({
  children,
  onReference,
}: PropsWithChildren<{ onReference: ReferenceMarkdownImage }>) {
  return (
    <MarkdownImageReferenceContext.Provider value={onReference}>{children}</MarkdownImageReferenceContext.Provider>
  );
}

export function useMarkdownImageReference(): ReferenceMarkdownImage | null {
  return useContext(MarkdownImageReferenceContext);
}
