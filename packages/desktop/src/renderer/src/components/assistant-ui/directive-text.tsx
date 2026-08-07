"use client";

import { type TextMessagePartComponent } from "@assistant-ui/react";
import { memo } from "react";
import { DirectiveTextContent } from "./directive-text-content.tsx";

/** Renders assistant-ui directives and legacy Pi composer file references as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(function DirectiveText({ text }) {
  return <DirectiveTextContent text={text} />;
});
