import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const executable = process.env.LIBREOFFICE_BIN ?? "soffice";
const maxDifferentPixels = Number(process.env.OFFICE_INTEROP_MAX_DIFFERENT_PIXELS ?? "1000");
if (!Number.isSafeInteger(maxDifferentPixels) || maxDifferentPixels < 0)
	throw new Error("OFFICE_INTEROP_MAX_DIFFERENT_PIXELS must be a non-negative integer");

export async function runLibreOfficeInterop(config) {
	const packageRoot = resolve(import.meta.dirname, "..");
	const workDir = resolve(process.argv[2] ?? resolve(packageRoot, config.defaultDirectory));
	const run = (command, args, options = {}) => {
		const result = spawnSync(command, args, {
			cwd: packageRoot,
			encoding: "utf8",
			timeout: 120_000,
			stdio: options.capture ? "pipe" : "inherit",
			...options,
		});
		if (result.error) throw result.error;
		if (result.status !== 0 && !options.allowDifference) throw new Error(`${command} exited with ${result.status}`);
		return result;
	};

	run("npm", ["run", config.validateScript, "--", workDir]);
	const manifest = JSON.parse(await readFile(resolve(workDir, "manifest.json"), "utf8"));
	const cases = config.cases(manifest, workDir);
	if (!Array.isArray(cases) || cases.length === 0) throw new Error("Invalid interoperability manifest");
	run(executable, ["--version"], { capture: true });
	run("pdftoppm", ["-v"], { capture: true });
	run("compare", ["-version"], { capture: true });

	const profileRoot = await mkdtemp(resolve(tmpdir(), "pi-office-interop-"));
	const providerRoot = resolve(workDir, "visual", "libreoffice");
	const reopenedDir = resolve(workDir, "reopened", "libreoffice");
	await rm(reopenedDir, { recursive: true, force: true });
	await rm(providerRoot, { recursive: true, force: true });
	const baselinePdfDir = resolve(providerRoot, "baseline-pdf");
	const reopenedPdfDir = resolve(providerRoot, "reopened-pdf");
	const baselinePngDir = resolve(providerRoot, "baseline-png");
	const reopenedPngDir = resolve(providerRoot, "reopened-png");
	await Promise.all([reopenedDir, baselinePdfDir, reopenedPdfDir, baselinePngDir, reopenedPngDir].map((path) => mkdir(path, { recursive: true })));

	const convertMany = async (inputs, outDir, format) => {
		const profile = await mkdtemp(resolve(profileRoot, "lo-profile-"));
		let result;
		try {
			result = run(
				executable,
				[
					`-env:UserInstallation=${pathToFileURL(profile).href}`,
					"--headless",
					"--nologo",
					"--nodefault",
					"--nolockcheck",
					"--convert-to",
					format,
					"--outdir",
					outDir,
					...inputs,
				],
				{ capture: true },
			);
		} finally {
			await rm(profile, { recursive: true, force: true });
		}
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
		if (/\b(?:repair|corrupt|error)\b/iu.test(output)) throw new Error(`LibreOffice reported damaged content:\n${output}`);
		const outputs = inputs.map((input) => resolve(outDir, `${basename(input, extname(input))}.${format}`));
		for (const outputPath of outputs) {
			if ((await stat(outputPath)).size === 0) throw new Error(`LibreOffice produced an empty ${format}: ${outputPath}`);
		}
		return outputs;
	};

	try {
		const inputs = cases.map((entry) => entry.input);
		const reopened = await convertMany(inputs, reopenedDir, config.extension);
		const baselinePdfs = await convertMany(inputs, baselinePdfDir, "pdf");
		const reopenedPdfs = await convertMany(reopened, reopenedPdfDir, "pdf");
		for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
			const entry = cases[caseIndex];
			const baselinePdf = baselinePdfs[caseIndex];
			const reopenedPdf = reopenedPdfs[caseIndex];
			run("pdftoppm", ["-png", "-r", "144", baselinePdf, resolve(baselinePngDir, entry.id)]);
			run("pdftoppm", ["-png", "-r", "144", reopenedPdf, resolve(reopenedPngDir, entry.id)]);
			const baselinePages = (await readdir(baselinePngDir)).filter((name) => name.startsWith(`${entry.id}-`) && name.endsWith(".png")).sort();
			const reopenedPages = (await readdir(reopenedPngDir)).filter((name) => name.startsWith(`${entry.id}-`) && name.endsWith(".png")).sort();
			if (baselinePages.length === 0 || baselinePages.length !== reopenedPages.length)
				throw new Error(`${entry.id}: visual page count changed after LibreOffice reopen`);
			for (let index = 0; index < baselinePages.length; index += 1) {
				const difference = run(
					"compare",
					[
						"-metric",
						"AE",
						"-fuzz",
						"1%",
						resolve(baselinePngDir, baselinePages[index]),
						resolve(reopenedPngDir, reopenedPages[index]),
						"null:",
					],
					{ capture: true, allowDifference: true },
				);
				if (difference.status !== 0 && difference.status !== 1) throw new Error(`ImageMagick compare failed for ${entry.id}`);
				const metric = Number.parseFloat((difference.stderr ?? "").trim());
				if (!Number.isFinite(metric) || metric > maxDifferentPixels)
					throw new Error(`${entry.id}: ${metric} pixels changed after LibreOffice reopen (limit ${maxDifferentPixels})`);
			}
		}
	} finally {
		await rm(profileRoot, { recursive: true, force: true });
	}

	run("npm", ["run", config.verifyScript, "--", workDir, "libreoffice"]);
	console.log(`LibreOffice ${config.extension.toUpperCase()} interoperability and visual checks passed in ${workDir}`);
}
