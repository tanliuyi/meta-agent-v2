import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { inspectXlsx, PackageArchive, planXlsx, commitXlsx, sha256Hex } from "../src/index.ts";
import { assertXlsxCorpusAdmission } from "./corpus-admission.ts";

const CASE_ID = "set-existing-cell";

interface Manifest {
  schemaVersion: 1;
  generatedAt: string;
  case: { id: string; input: string; inputSha256: string; sheetId: string; cellId: string; address: string; expectedValue: string };
}

async function main(): Promise<void> {
  const [command, rootArg, provider] = process.argv.slice(2);
  const root = resolve(rootArg ?? "office-xlsx-interop-artifacts");
  if (command === "generate") return generate(root);
  if (command === "validate") return void await validate(root);
  if (command === "verify") {
    if (provider !== "libreoffice" && provider !== "excel") throw new Error("provider must be libreoffice or excel");
    const manifest = await validate(root);
    const output = join(root, "reopened", provider, basename(manifest.case.input));
    const snapshot = inspectXlsx(PackageArchive.open(await readFile(output)), "external-xlsx");
    const cell = snapshot.sheets.find((sheet) => sheet.id === manifest.case.sheetId)?.cells.find((item) => item.id === manifest.case.cellId);
    if (!cell || cell.address !== manifest.case.address || cell.value !== manifest.case.expectedValue) throw new Error(`${provider}: XLSX semantic verification failed`);
    return;
  }
  throw new Error("usage: xlsx-interop.ts <generate|validate|verify> <root> [libreoffice|excel]");
}

async function generate(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, "inputs"), { recursive: true });
  const admitted = assertXlsxCorpusAdmission();
  const fixture = admitted.manifest.fixtures[0];
  if (!fixture) throw new Error("admitted XLSX corpus is empty");
  const source = await readFile(join(admitted.root, fixture.filename));
  const archive = PackageArchive.open(source);
  const snapshot = inspectXlsx(archive, "xlsx-interop");
  const sheet = snapshot.sheets.find((item) => item.id === "sheet:rId1");
  const cell = sheet?.cells.find((item) => item.address === "A1");
  if (!sheet || !cell || !cell.editable) throw new Error("admitted XLSX corpus target missing");
  const expectedValue = "Interop approved";
  const plan = planXlsx(archive, snapshot, {
    protocolVersion: 1,
    operations: [{
      type: "set_cell_value",
      target: { sheetId: sheet.id, cellId: cell.id, address: cell.address },
      precondition: { documentRevision: snapshot.revision, expectedValue: cell.value, expectedValueSha256: cell.valueSha256 },
      replacement: expectedValue,
    }],
  }, Date.now() + 60_000);
  const output = commitXlsx(archive, snapshot, plan);
  const input = `${CASE_ID}.xlsx`;
  await writeFile(join(root, "inputs", input), output);
  const manifest: Manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    case: { id: CASE_ID, input: `inputs/${input}`, inputSha256: sha256Hex(output), sheetId: sheet.id, cellId: cell.id, address: cell.address, expectedValue },
  };
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function validate(root: string): Promise<Manifest> {
  const raw: unknown = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("XLSX manifest invalid");
  const manifest = raw as Record<string, unknown>;
  exact(manifest, ["schemaVersion", "generatedAt", "case"]);
  if (manifest.schemaVersion !== 1 || typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))) throw new Error("XLSX manifest invalid");
  const item = record(manifest.case);
  exact(item, ["id", "input", "inputSha256", "sheetId", "cellId", "address", "expectedValue"]);
  if (item.id !== CASE_ID || item.input !== `inputs/${CASE_ID}.xlsx` || typeof item.inputSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(item.inputSha256)) throw new Error("XLSX manifest case invalid");
  for (const key of ["sheetId", "cellId", "address", "expectedValue"] as const) if (typeof item[key] !== "string" || !item[key]) throw new Error("XLSX manifest case invalid");
  const input = await readFile(join(root, item.input));
  if (sha256Hex(input) !== item.inputSha256) throw new Error("XLSX generated input hash mismatch");
  return { schemaVersion: 1, generatedAt: manifest.generatedAt, case: item as Manifest["case"] };
}
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("XLSX manifest object expected"); return value as Record<string, unknown>; }
function exact(value: Record<string, unknown>, expected: readonly string[]): void { const actual = Object.keys(value).sort(), keys = [...expected].sort(); if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error("XLSX manifest keys invalid"); }

await main();
