#!/usr/bin/env node
import { defaultSessionPath } from "./session.mjs";

const [apiRoot, publisherId = ""] = process.argv.slice(2);
if (!apiRoot) {
  console.error("usage: node session-path.mjs <apiRoot> [publisherId]");
  process.exitCode = 2;
} else {
  console.log(defaultSessionPath(apiRoot, publisherId));
}
