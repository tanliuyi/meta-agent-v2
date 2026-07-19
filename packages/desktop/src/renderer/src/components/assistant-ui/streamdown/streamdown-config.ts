// import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { createElement } from "react";
import type { LinkSafetyConfig } from "streamdown";
import { LinkSafetyModal } from "./link-safety-modal.tsx";

export const STREAMDOWN_PLUGINS = { code, math, mermaid } as const;
export const SHIKI_THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];

export const LINK_SAFETY: LinkSafetyConfig = {
  enabled: true,
  renderModal: (props) => createElement(LinkSafetyModal, props),
};
