#!/usr/bin/env node
// Marketplace login: authenticate, verify publisher membership, and write an
// expiring session record to a 0600 file.
//
// Usage:
//   node login.mjs <apiRoot> <username> <passwordFile> <tokenOut> <publisherId>
//
// Secrets never appear on the command line: the password is read from
// passwordFile (create it with owner-only permissions, delete it afterwards).
// The session record contains only the bearer token and server-provided
// expiresAt; login-web.mjs can reuse it until it expires.
import { readFileSync, rmSync } from "node:fs";
import { writeSession } from "./session.mjs";

async function main() {
  const [apiRoot, user, passFile, tokenOut, publisherId] = process.argv.slice(2);
  if (!apiRoot || !user || !passFile || !tokenOut || !publisherId) {
    console.error("usage: node login.mjs <apiRoot> <username> <passwordFile> <tokenOut> <publisherId>");
    process.exitCode = 2;
    return;
  }

  const password = readFileSync(passFile, "utf8").trim();
  if (!password) throw new Error("empty password file");

  const loginRes = await fetch(`${apiRoot}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: user, password }),
  });
  if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
  const authData = await loginRes.json();
  const { token, expiresAt } = authData;
  if (!token || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("login response missing a valid token expiry");
  }

  try {
    writeSession(tokenOut, { token, expiresAt });
  } catch (err) {
    throw new Error(`cannot write token file: ${err.message}`);
  }

  const meRes = await fetch(`${apiRoot}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meRes.ok) throw new Error(`auth/me failed: ${meRes.status} ${await meRes.text()}`);
  const me = await meRes.json();
  console.log(
    "me:",
    JSON.stringify({ admin: me.admin, username: me.user?.username, publisherIds: me.publisherIds }),
  );
  if (!me.publisherIds?.includes(publisherId)) {
    rmSync(tokenOut, { force: true });
    throw new Error(`publisher membership missing: ${publisherId}`);
  }
  console.log(`LOGIN_OK session written to ${tokenOut} (expires: ${new Date(expiresAt).toISOString()})`);
}

main().catch((err) => {
  console.error("LOGIN FAILED:", err.message);
  process.exitCode = 1;
});
