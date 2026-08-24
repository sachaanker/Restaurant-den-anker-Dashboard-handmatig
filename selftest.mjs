// Run with: node selftest.mjs
// Catches the failure mode where a write silently truncates or null-pads a
// file: the file still "exists" and may even parse, but deploys to a blank
// page or a worker that does nothing. Never push if this fails.

import { readFileSync, existsSync } from "node:fs";
import { Script } from "node:vm";

let failures = 0;
function fail(msg) {
  failures++;
  console.error("FAIL:", msg);
}
function ok(msg) {
  console.log("OK:  ", msg);
}

function checkNoNulls(path, content) {
  if (content.includes("\u0000")) fail(`${path} contains null bytes (truncation/sync hazard)`);
}

function checkFile(path, minBytes, requiredSnippets = []) {
  if (!existsSync(path)) {
    fail(`${path} is missing`);
    return null;
  }
  const content = readFileSync(path, "utf8");
  checkNoNulls(path, content);
  if (content.length < minBytes) {
    fail(`${path} is only ${content.length} bytes — expected at least ${minBytes} (looks truncated)`);
  } else {
    ok(`${path} present, ${content.length} bytes`);
  }
  for (const snippet of requiredSnippets) {
    if (!content.includes(snippet)) fail(`${path} is missing expected content: "${snippet}"`);
  }
  return content;
}

// --- wrangler.toml ---
const toml = checkFile("wrangler.toml", 80, ["name =", "main =", "[assets]", "TOKENS"]);

// --- package.json ---
const pkg = checkFile("package.json", 50, ["wrangler"]);
if (pkg) {
  try {
    JSON.parse(pkg);
    ok("package.json is valid JSON");
  } catch (e) {
    fail("package.json failed to parse: " + e.message);
  }
}

// --- worker.js: must parse as JS and export a fetch handler ---
const workerSrc = checkFile("worker.js", 3000, ["export default", "fetch(request", "TOKENS", "INGEST_TOKEN"]);
if (workerSrc) {
  try {
    // Strip the ES module export so plain Script() can parse the body syntax.
    const stripped = workerSrc.replace(/export default/, "const __handler =");
    new Script(stripped, { filename: "worker.js" });
    ok("worker.js parses as valid JavaScript");
  } catch (e) {
    fail("worker.js failed to parse: " + e.message);
  }
}

// --- public/index.html ---
checkFile("public/index.html", 2000, ["<html", "screen-dashboard", "app.js", "styles.css"]);

// --- public/styles.css ---
checkFile("public/styles.css", 1000, ["--ink", "--brass"]);

// --- public/app.js ---
const appSrc = checkFile("public/app.js", 3000, ["boot()", "/api/status", "/api/data"]);
if (appSrc) {
  try {
    new Script(appSrc, { filename: "app.js" });
    ok("public/app.js parses as valid JavaScript");
  } catch (e) {
    fail("public/app.js failed to parse: " + e.message);
  }
}

console.log("---");
if (failures > 0) {
  console.error(`${failures} check(s) failed. Do not push.`);
  process.exit(1);
} else {
  console.log("All checks passed. Safe to push.");
  process.exit(0);
}
