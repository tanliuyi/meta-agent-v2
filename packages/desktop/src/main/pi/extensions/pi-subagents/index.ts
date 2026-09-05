import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {} from "./src/types/pi-runtime-compat.d.ts";
import type { ChildSessionFactory } from "./src/runs/shared/child-session.ts";
import registerParentExtension from "./src/extension/index.ts";

export default function registerSubagentExtension(pi: ExtensionAPI, childSessionFactory?: ChildSessionFactory): void {
	registerParentExtension(pi, childSessionFactory);
}
