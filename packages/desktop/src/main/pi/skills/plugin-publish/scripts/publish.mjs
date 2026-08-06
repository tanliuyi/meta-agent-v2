#!/usr/bin/env node
// Declare plugin metadata, create a draft version, upload artifact(s),
// and publish — driven by a JSON spec file (no secrets in the spec).
//
// Usage:
//   node publish.mjs <apiRoot> <tokenFile> <spec.json> <payload.zip>... [--yes]
//
// The i-th payload.zip argument maps to the i-th declared artifact; when a
// single zip is given it is uploaded for every artifact. The spec mirrors the
// Marketplace Publish API v1 request bodies (see scripts/spec.example.json).
//
// Publication is irreversible through the draft-delete API. Run this only
// after the user has explicitly asked to publish this plugin/version.
// Default behavior pauses 3 seconds before publishing so an unintended run
// can be Ctrl-C'd; pass --yes to skip the pause.
import { readFileSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  const yes = args.includes("--yes");
  const [apiRoot, tokenFile, specFile, ...zips] = args.filter((a) => a !== "--yes");
  if (!apiRoot || !tokenFile || !specFile || !zips.length) {
    console.error("usage: node publish.mjs <apiRoot> <tokenFile> <spec.json> <payload.zip>... [--yes]");
    process.exitCode = 2;
    return;
  }
  const token = readFileSync(tokenFile, "utf8").trim();
  const spec = JSON.parse(readFileSync(specFile, "utf8"));
  const { pluginId, version, artifacts } = spec;
  if (!pluginId || !version || !Array.isArray(artifacts) || !artifacts.length) {
    throw new Error("spec must contain pluginId, version, and a non-empty artifacts array");
  }

  const auth = { Authorization: `Bearer ${token}` };
  const json = { ...auth, "Content-Type": "application/json" };

  async function req(method, pathname, body, raw) {
    const res = await fetch(`${apiRoot}${pathname}`, {
      method,
      headers: raw ? { ...auth, "Content-Type": "application/zip" } : json,
      body,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(`FAIL ${method} ${pathname}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }

  // 1. Declare plugin metadata.
  const plugin = await req("PUT", `/publish/plugins/${pluginId}`, JSON.stringify({
    name: spec.name,
    description: spec.description,
    publisherId: spec.publisherId,
    categories: spec.categories,
    ...(spec.iconAssetId ? { iconAssetId: spec.iconAssetId } : {}),
  }));
  console.log("plugin declared:", JSON.stringify({ id: plugin.id ?? plugin.pluginId ?? pluginId }));

  // 2. Create draft version.
  const draftBody = {
    version,
    changelog: spec.changelog ?? "",
    desktop: spec.desktop ?? {},
    capabilities: spec.capabilities ?? [],
    artifacts,
  };
  if (spec.configuration) draftBody.configuration = spec.configuration;
  const draft = await req("POST", `/publish/plugins/${pluginId}/versions`, JSON.stringify(draftBody));
  console.log("draft created:", JSON.stringify({ version: draft.version ?? version, status: draft.status }));

  // 3. Upload artifacts.
  const zipBufs = zips.map((z) => readFileSync(z));
  for (let i = 0; i < artifacts.length; i++) {
    const art = artifacts[i];
    const buf = zipBufs[Math.min(i, zipBufs.length - 1)];
    const uploaded = await req(
      "PUT",
      `/publish/plugins/${pluginId}/versions/${version}/artifacts/${art.id}`,
      buf,
      true,
    );
    console.log(`artifact ${art.id} uploaded:`, JSON.stringify(uploaded));
    if (!uploaded?.sha256 || !uploaded?.size) {
      throw new Error(`artifact ${art.id} upload missing hash/size; server reported an incomplete version`);
    }
  }

  // 4. Publish (irreversible through draft-delete).
  if (!yes) {
    console.error(`About to publish ${pluginId} ${version}. Ctrl-C to abort, or rerun with --yes.`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const published = await req("POST", `/publish/plugins/${pluginId}/versions/${version}/publish`);
  console.log("published:", JSON.stringify(published));
  console.log(`PUBLISHED ${pluginId}@${version}`);
}

main().catch((err) => {
  console.error("PUBLISH FAILED:", err.message);
  process.exitCode = 1;
});
