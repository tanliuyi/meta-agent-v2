#!/usr/bin/env node
// Verify a published version through the public read API.
//
// Usage:
//   node verify.mjs <apiRoot> <pluginId> <version> [--out <dir>] [--key <publicKeyFile>]
//
// Checks, in order:
//   1. Public plugin detail reports the version as available.
//   2. Version detail and artifact list are readable.
//   3. The download endpoint (metadata JSON with a `url` field — the metadata
//      response itself is NOT the artifact) yields real bytes; the archive's
//      SHA-256 and byte length match the catalog values.
//   4. The .meta-plugin archive unpacks to market-manifest.json +
//      signature.json + payload/; the manifest names the expected plugin,
//      version, entry, target, capabilities and the full payload file set.
//   5. When --key is given, verify signature.json over canonical JSON of
//      market-manifest.json with the Ed25519 public key from discovery
//      (raw 32-byte, PKIX DER, or JWK formats are accepted).
//
// Fetched archives are saved under --out (default: current directory).
import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256, zipEntries } from "./lib/zip.mjs";

async function main() {
  const args = process.argv.slice(2);
  let outDir = ".";
  let keyFile = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) outDir = args[++i];
    else if (args[i] === "--key" && args[i + 1]) keyFile = args[++i];
    else positional.push(args[i]);
  }
  const [apiRoot, pluginId, version] = positional;
  if (!apiRoot || !pluginId || !version) {
    console.error("usage: node verify.mjs <apiRoot> <pluginId> <version> [--out <dir>] [--key <publicKeyFile>]");
    process.exitCode = 2;
    return;
  }

  async function req(pathname) {
    const res = await fetch(`${apiRoot}${pathname}`);
    if (!res.ok) throw new Error(`FAIL GET ${pathname}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // 1-2. Public plugin/version/artifact metadata.
  const pub = await req(`/plugins/${pluginId}`);
  const ver = await req(`/plugins/${pluginId}/versions/${version}`);
  const artsRes = await req(`/plugins/${pluginId}/versions/${version}/artifacts`);
  const arts = Array.isArray(artsRes) ? artsRes : artsRes.artifacts;
  console.log(
    "public plugin:",
    JSON.stringify({ id: pub.id, latestVersion: pub.latestVersion, status: pub.status }),
  );
  if (ver.status !== "available") throw new Error(`version status is ${ver.status}, expected available`);
  if (!Array.isArray(arts) || !arts.length) throw new Error("no artifacts listed");
  mkdirSync(outDir, { recursive: true });

  // 3. Download each artifact and compare hash/size.
  for (const art of arts) {
    const meta = await req(`/plugins/${pluginId}/versions/${version}/artifacts/${art.id}/download`);
    const url = meta.url ?? meta.downloadUrl;
    if (!url) throw new Error(`download metadata for ${art.id} has no url field`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${url}: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha256(buf);
    console.log(`artifact ${art.id}: size ${buf.length}, sha256 ${hash}`);
    const expectSha = art.sha256 ?? meta.sha256;
    const expectSize = art.size ?? meta.size;
    if (expectSha && expectSha !== hash) throw new Error(`sha256 mismatch for ${art.id}: ${hash} != ${expectSha}`);
    if (expectSize && expectSize !== buf.length) {
      throw new Error(`size mismatch for ${art.id}: ${buf.length} != ${expectSize}`);
    }
    const outFile = path.join(outDir, `${pluginId}-${version}-${art.id}.meta-plugin`);
    writeFileSync(outFile, buf);
    console.log(`saved ${outFile}`);

    // 4. Unpack and inspect the signed archive.
    let entries;
    try {
      entries = zipEntries(buf);
    } catch (err) {
      throw new Error(`cannot unpack archive: ${err.message}`);
    }
    const names = entries.map((e) => e.name);
    const get = (n) => entries.find((e) => e.name === n)?.data;
    const manifest = get("market-manifest.json");
    if (!manifest) throw new Error("archive missing market-manifest.json");
    const m = JSON.parse(manifest.toString("utf8"));
    const payloadNames = names.filter((n) => n.startsWith("payload/"));
    const mPluginId = m.plugin?.id ?? m.pluginId;
    const mVersion = m.plugin?.version ?? m.version;
    const mEntry = m.pi?.entry ?? m.entry;
    const mHost = m.desktop?.hostProfileVersion ?? m.hostProfileVersion;
    console.log(
      "manifest:",
      JSON.stringify({
        pluginId: mPluginId,
        version: mVersion,
        entry: mEntry,
        target: m.target,
        hostProfileVersion: mHost,
        capabilities: m.capabilities,
        files: payloadNames.length,
      }),
    );
    if (mPluginId !== pluginId) throw new Error(`manifest pluginId ${mPluginId} != ${pluginId}`);
    if (mVersion !== version) throw new Error(`manifest version ${mVersion} != ${version}`);
    const expected = new Set(payloadNames);
    // Server manifests list files either as an array ("path" or string entries)
    // or as an object keyed by payload-relative path ("path": { "mode": ... }).
    const listed = Array.isArray(m.files)
      ? m.files
      : Object.keys(m.files ?? {}).map((p) => ({ path: p }));
    for (const f of listed) {
      const p = f.path ?? f;
      if (!expected.has(p)) throw new Error(`manifest lists ${p} but archive does not contain it`);
    }

    // 5. Optional Ed25519 signature verification.
    if (keyFile) {
      const sigEntry = get("signature.json");
      if (!sigEntry) throw new Error("archive missing signature.json");
      const sigJson = JSON.parse(sigEntry.toString("utf8"));
      const sig = Buffer.from(sigJson.signature ?? sigJson.sig ?? sigJson, "base64");
      const payload = Buffer.from(canonicalJson(m), "utf8");
      let ok = false;
      const raw = readFileSync(keyFile);
      const attempts = [
        () => ({ key: raw }),
        () => ({ key: raw, format: "der", type: "spki" }),
        () => ({ key: JSON.parse(raw.toString("utf8")), format: "jwk" }),
      ];
      for (const make of attempts) {
        try {
          if (verify(null, payload, createPublicKey(make()), sig)) {
            ok = true;
            break;
          }
        } catch {
          // try next format
        }
      }
      if (!ok) throw new Error("Ed25519 signature verification failed");
      console.log("signature: OK");
    }
  }

  console.log("VERIFY_OK");
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err.message);
  process.exitCode = 1;
});
