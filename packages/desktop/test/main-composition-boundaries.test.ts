import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "../src");
const mainRoot = resolve(sourceRoot, "main");
const rendererRoot = resolve(sourceRoot, "renderer");
const sidecarRoot = resolve(mainRoot, "sidecar");
const sessionRoot = resolve(mainRoot, "session");
const bootstrapRoot = resolve(mainRoot, "bootstrap");
const sessionSupervisor = resolve(sessionRoot, "session-supervisor.ts");
const threadWorkerRegistry = resolve(sidecarRoot, "thread-worker-registry.ts");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);

describe("Desktop main composition boundaries", () => {
  it("keeps bootstrap imports out of domain services", async () => {
    const violations = await findViolations(mainRoot, (file, specifier) => {
      if (isWithin(file, bootstrapRoot) || file === resolve(mainRoot, "index.ts")) return false;
      return resolvesWithin(file, specifier, bootstrapRoot);
    });
    expect(violations).toEqual([]);
  });

  it("keeps session application services independent from Pi, Electron, and sidecar implementations", async () => {
    const violations = await findViolations(
      sessionRoot,
      (file, specifier) =>
        specifier === "electron" ||
        specifier.startsWith("electron/") ||
        specifier.startsWith("@earendil-works/pi") ||
        resolvesWithin(file, specifier, resolve(mainRoot, "pi")) ||
        resolvesWithin(file, specifier, sidecarRoot),
    );
    expect(violations).toEqual([]);
  });

  it("keeps concrete session and worker implementations confined to the composition root", async () => {
    const violations = await findViolations(mainRoot, (file, specifier) => {
      const target = resolveImport(file, specifier);
      if (target === sessionSupervisor) return !isWithin(file, bootstrapRoot);
      if (target === threadWorkerRegistry) return file !== resolve(bootstrapRoot, "session-services.ts");
      return false;
    });
    expect(violations).toEqual([]);
  });

  it("keeps renderer code independent from main process modules", async () => {
    const violations = await findViolations(
      rendererRoot,
      (file, specifier) => specifier.startsWith("@main/") || resolvesWithin(file, specifier, mainRoot),
    );
    expect(violations).toEqual([]);
  });

  it("keeps sidecars independent from bootstrap, index and Electron", async () => {
    const violations = await findViolations(
      sidecarRoot,
      (file, specifier) =>
        specifier === "electron" ||
        specifier.startsWith("electron/") ||
        resolvesWithin(file, specifier, resolve(mainRoot, "bootstrap")) ||
        resolveImport(file, specifier) === resolve(mainRoot, "index.ts"),
    );
    expect(violations).toEqual([]);
  });
});

async function findViolations(
  root: string,
  forbidden: (file: string, specifier: string) => boolean,
): Promise<string[]> {
  const violations: string[] = [];
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (forbidden(file, specifier)) violations.push(`${relative(sourceRoot, file)} -> ${specifier}`);
    }
  }
  return violations.sort();
}

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return sourceExtensions.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return nested.flat();
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:\bfrom\s+|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolvesWithin(file: string, specifier: string, root: string): boolean {
  const target = resolveImport(file, specifier);
  return target !== undefined && isWithin(target, root);
}

function resolveImport(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return resolve(file, "..", specifier);
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}
