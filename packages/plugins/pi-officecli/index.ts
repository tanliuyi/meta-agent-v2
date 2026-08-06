import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRunner } from "./src/cli.ts";
import { resolveConfig } from "./src/config.ts";
import { registerInspectTools } from "./src/tools/inspect.ts";
import { registerReadTools } from "./src/tools/read.ts";
import { registerWriteTools } from "./src/tools/write.ts";

/**
 * pi-officecli: Office document create/read/edit for .docx/.xlsx/.pptx,
 * powered by the OfficeCLI binary (https://github.com/iOfficeAI/OfficeCLI).
 *
 * The binary is auto-downloaded on first use (pinned release tag, SHA256
 * verified) unless `binaryPath` is configured.
 */
export default function piOfficeCli(pi: ExtensionAPI): void {
  const config = resolveConfig(pi.getConfig());
  const runner = createRunner(config);
  registerReadTools(pi, runner);
  registerWriteTools(pi, runner);
  registerInspectTools(pi, runner);
}
