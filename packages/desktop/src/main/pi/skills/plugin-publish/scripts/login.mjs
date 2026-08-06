#!/usr/bin/env node
// Marketplace login: authenticate, verify publisher membership, write the
// session token to a 0600 file.
//
// Usage:
//   node login.mjs <apiRoot> <username> <passwordFile> <tokenOut> <publisherId>
//
// Secrets never appear on the command line: the password is read from
// passwordFile (create it with owner-only permissions, delete it afterwards).
// The session token is written to tokenOut with mode 0600 and must be deleted
// after publishing. Exit 0 with "LOGIN_OK" on success.
import { readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";

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
  const { token } = await loginRes.json();
  if (!token) throw new Error("login response missing token");

  try {
    writeFileSync(tokenOut, token, { mode: 0o600 });
    chmodSync(tokenOut, 0o600);
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
  console.log(`LOGIN_OK token written to ${tokenOut}`);
}

main().catch((err) => {
  console.error("LOGIN FAILED:", err.message);
  process.exitCode = 1;
});
