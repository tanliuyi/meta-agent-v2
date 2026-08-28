import { describe, expect, it } from "vitest";
import { INTEROP_DEFINITIONS, type InteropManifest, validateInteropManifest } from "../scripts/interop-manifest.ts";

const validManifest = (): InteropManifest => ({
	schemaVersion: 1,
	generatedAt: "2026-08-28T00:00:00.000Z",
	cases: INTEROP_DEFINITIONS.map((definition) => ({
		...definition,
		generatedSha256: "a".repeat(64),
	})),
});

const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(validManifest())) as Record<string, unknown>;

const cases = (manifest: Record<string, unknown>): Array<Record<string, unknown>> =>
	manifest.cases as Array<Record<string, unknown>>;

describe("DOCX interoperability manifest", () => {
	it("accepts the fixed eight-case manifest", () => {
		expect(validateInteropManifest(validManifest())).toEqual(validManifest());
	});

	it("rejects an empty, missing, duplicated, or reordered matrix", () => {
		const empty = clone();
		empty.cases = [];
		expect(() => validateInteropManifest(empty)).toThrow("case count");

		const missing = clone();
		cases(missing).pop();
		expect(() => validateInteropManifest(missing)).toThrow("case count");

		const duplicated = clone();
		cases(duplicated)[1] = cases(duplicated)[0];
		expect(() => validateInteropManifest(duplicated)).toThrow("case 1");

		const reordered = clone();
		[cases(reordered)[0], cases(reordered)[1]] = [cases(reordered)[1], cases(reordered)[0]];
		expect(() => validateInteropManifest(reordered)).toThrow("case 0");
	});

	it("rejects path-like IDs, unknown fields, and invalid hashes", () => {
		const pathId = clone();
		cases(pathId)[0].id = "../replace-text-run";
		expect(() => validateInteropManifest(pathId)).toThrow("case 0");

		const unknown = clone();
		cases(unknown)[0].extra = true;
		expect(() => validateInteropManifest(unknown)).toThrow("unknown or missing key");

		const hash = clone();
		cases(hash)[0].generatedSha256 = "not-a-hash";
		expect(() => validateInteropManifest(hash)).toThrow("case 0");
	});

	it("rejects probe changes and invalid timestamps", () => {
		const probe = clone();
		const firstProbe = cases(probe)[0].probe as Record<string, unknown>;
		firstProbe.requiredTexts = [];
		expect(() => validateInteropManifest(probe)).toThrow("probe replace-text-run");

		const timestamp = clone();
		timestamp.generatedAt = "invalid";
		expect(() => validateInteropManifest(timestamp)).toThrow("header");
	});
});
