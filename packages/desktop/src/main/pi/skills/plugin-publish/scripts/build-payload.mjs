#!/usr/bin/env node
// Build a marketplace payload ZIP with POSIX-relative paths.
//
// Usage:
//   node build-payload.mjs <pluginDir> <out.zip> [entry...]
//
// Each entry is a file or directory relative to pluginDir. Directories are
// walked recursively. Default entries use the manifest's "pi.entry", plus
// "src" and "assets/icon.svg". Standard plugins must ship the SVG resource.
// The marketplace can use this packaged artwork without a separate asset upload.
// Default exclusions (never packaged): test*, *.test.*, node_modules,
// dist, .git, *.map, .DS_Store, .env*, *.log, package-lock.json, market-manifest.json.
//
// Output: a ZIP whose names are validated payload-relative POSIX paths
// (no absolute paths, backslashes, ".", "..", empty segments, control chars).
// The marketplace repacks the ZIP under a payload/ prefix, so a name that
// already starts with "payload/" is rejected: declare artifacts[].entry
// relative to the ZIP root (e.g. index.js), never payload/index.js.
// Exit code 1 with a listing of the offending names when validation fails.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { zipToBuffer } from "./lib/zip.mjs";

const EXCLUDE = /(^|\/)(node_modules|dist|\.git)(\/|$)|\.test\.[jt]s$|\.map$|\.DS_Store$|\.env(\.|$)|\.log$|package-lock\.json$|market-manifest\.json$/;

function collect(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = path.posix.join(base, name);
    if (EXCLUDE.test(rel)) continue;
    const st = statSync(full);
    if (st.isDirectory()) collect(full, rel, out);
    else if (st.isFile()) out.push({ name: rel, data: readFileSync(full) });
  }
}

function getDefaultEntries(root) {
  const manifestPath = path.join(root, "market-manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${manifestPath}: ${err.message}`);
  }
  const entry = manifest?.pi?.entry;
  if (typeof entry !== "string" || !entry) {
    throw new Error(`${manifestPath} must declare a non-empty pi.entry`);
  }
  return [entry, "src", "assets/icon.svg"];
}

function main() {
  const [root, outZip, ...entries] = process.argv.slice(2);
  if (!root || !outZip) {
    console.error("usage: node build-payload.mjs <pluginDir> <out.zip> [entry...]");
    process.exit(2);
  }
  const list = entries.length ? entries : getDefaultEntries(root);
  const out = [];
  for (const e of list) {
    const full = path.join(root, e);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, e, out);
    else if (st.isFile()) out.push({ name: e, data: readFileSync(full) });
    else throw new Error(`not a file or directory: ${e}`);
  }
  const bad = out
    .map((x) => x.name)
    .filter(
      (n) =>
        !n ||
        n.startsWith("/") ||
        n.startsWith("payload/") ||
        n.includes("\\") ||
        /(^|\/)\.\.?(\/|$)/.test(n) ||
        /[\x00-\x1f]/.test(n),
    );
  if (bad.length) {
    console.error("INVALID PATHS:", bad.join(", "));
    console.error(
      "The marketplace repacks the ZIP under a payload/ prefix; the payload itself must not contain payload/ paths. " +
        "Declare artifacts[].entry relative to the ZIP root (e.g. index.js), never payload/index.js.",
    );
    process.exit(1);
  }
  const buf = zipToBuffer(out);
  writeFileSync(outZip, buf);
  console.log(`OK ${out.length} files, ${buf.length} bytes -> ${outZip}`);
  for (const x of out) console.log("  " + x.name);
}

try {
  main();
} catch (err) {
  console.error("build-payload failed:", err.message);
  process.exit(1);
}
