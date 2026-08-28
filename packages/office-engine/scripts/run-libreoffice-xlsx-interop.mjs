import { resolve } from "node:path";
import { runLibreOfficeInterop } from "./libreoffice-interop-runner.mjs";

await runLibreOfficeInterop({
	defaultDirectory: ".xlsx-interop",
	extension: "xlsx",
	validateScript: "xlsx-interop:validate",
	verifyScript: "xlsx-interop:verify",
	cases(manifest, workDir) {
		if (manifest.schemaVersion !== 1 || !manifest.case || typeof manifest.case !== "object") return [];
		return [{ id: manifest.case.id, input: resolve(workDir, manifest.case.input) }];
	},
});
