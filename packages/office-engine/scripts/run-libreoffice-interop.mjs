import { resolve } from "node:path";
import { runLibreOfficeInterop } from "./libreoffice-interop-runner.mjs";

await runLibreOfficeInterop({
	defaultDirectory: ".interop",
	extension: "docx",
	validateScript: "interop:validate",
	verifyScript: "interop:verify",
	cases(manifest, workDir) {
		if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases)) return [];
		return manifest.cases.map((entry) => ({ id: entry.id, input: resolve(workDir, "inputs", `${entry.id}.docx`) }));
	},
});
