import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activateOfficePlugin } from "./src/plugin-call.ts";

/**
 * pi-officecli: Office document create/read/edit for .docx/.xlsx/.pptx,
 * powered by the OfficeCLI binary (https://github.com/iOfficeAI/OfficeCLI).
 *
 * The binary is auto-downloaded on first use (pinned release tag, SHA256
 * verified) unless `binaryPath` is configured.
 */
export default function piOfficeCli(pi: ExtensionAPI): void {
  pi.on("resources_discover", async () => ({
    skillPaths: [fileURLToPath(new URL("./skills/pi-officecli/SKILL.md", import.meta.url))],
  }));
  activateOfficePlugin(pi);
}
