#!/usr/bin/env node
// Fetch the marketplace discovery envelope and print trust-relevant fields.
//
// Usage:
//   node discover.mjs <publicBaseUrl> [--json]
//
// Prints { baseUrl, apiRoot, marketplaceId, protocolVersion, fingerprint,
// signingKey }. `apiRoot` already ends in /v1 — never append another /v1.
// The fingerprint is the SHA-256 of the canonical JSON of the `data` field.
// Require explicit trust for a first-seen fingerprint; never silently accept
// a changed one. This script only reports — the caller decides trust.
import { canonicalJson, sha256 } from "./lib/zip.mjs";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node discover.mjs <publicBaseUrl>");
  process.exit(2);
}
const res = await fetch(`${BASE.replace(/\/$/, "")}/.well-known/meta-agent-marketplace.json`);
if (!res.ok) {
  console.error(`discovery failed: ${res.status}`, await res.text());
  process.exit(1);
}
const env = await res.json();
// Two shapes exist in the wild: a signed { data, signature } envelope, and a
// plain { protocolVersion, marketplaceId, apiRoot } document. Handle both;
// report `signed: false` for the latter so the caller decides trust policy.
let data;
let signature = null;
if (env && typeof env === "object" && "data" in env) {
  data = typeof env.data === "string" ? JSON.parse(env.data) : env.data;
  signature = env.signature ?? null;
} else {
  data = env;
}
if (!data || typeof data !== "object") {
  console.error("discovery envelope missing data object");
  process.exit(1);
}
const fingerprint = sha256(Buffer.from(canonicalJson(data), "utf8"));
const out = {
  baseUrl: BASE,
  signed: !!signature,
  apiRoot: data.apiRoot,
  marketplaceId: data.marketplaceId,
  protocolVersion: data.protocolVersion,
  fingerprint,
  signingKey: data.signingIdentity?.publicKey ?? data.signingKey ?? null,
};
console.log(JSON.stringify(out, null, 2));
