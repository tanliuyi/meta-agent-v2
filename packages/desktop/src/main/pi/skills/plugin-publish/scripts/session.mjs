import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

export function defaultSessionPath(apiRoot, publisherId = "") {
  const key = createHash("sha256")
    .update(`${apiRoot}\u0000${publisherId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  const configHome = process.env.XDG_CONFIG_HOME || join(os.homedir(), ".config");
  return join(configHome, "meta-agent", "marketplace-sessions", `${key}.json`);
}

export function readSession(sessionPath) {
  try {
    const value = JSON.parse(readFileSync(sessionPath, "utf8"));
    if (
      !value ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return { token: value.token, expiresAt: value.expiresAt };
  } catch {
    return undefined;
  }
}

export function writeSession(sessionPath, session) {
  if (!Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) {
    throw new Error("authentication response contains an invalid or expired expiresAt");
  }
  mkdirSync(dirname(sessionPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(sessionPath), 0o700);
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  chmodSync(sessionPath, 0o600);
}

export function removeSession(sessionPath) {
  rmSync(sessionPath, { force: true });
}
