#!/usr/bin/env node
/**
 * prepublishOnly guard for @dragapp/mcp-server (PUBLIC package).
 *
 * Packs the tarball exactly as it would ship to npm, extracts it, and greps
 * EVERY packaged file (compiled dist/, package.json, and — importantly —
 * *.map source maps, which embed the original TypeScript source incl. comments)
 * for internal repo/function names. Aborts `npm publish` if any are found.
 *
 * This is the check that would have caught the original npm leak: TypeScript
 * comments survive into compiled output, and even with `removeComments` the
 * source maps still embed the original source.
 *
 * Canonical forbidden-term list — mirror any change in .gitleaks.toml.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FORBIDDEN = [
  "Dragsters-backend",
  "drag-automations",
  "drag-web",
  "drag-marketing",
  "Drag-pub-sub",
  "drag-chat",
  "CreateCardMapper",
  "fetchTaskDetails",
  "SendAsEmailContent",
  "JWTSECRET",
];
const NEEDLES = FORBIDDEN.map((t) => t.toLowerCase());

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function fail(msg) {
  console.error(`\n✗ tarball guard FAILED: ${msg}`);
  process.exit(1);
}

// 1. Pack the tarball. --ignore-scripts avoids re-triggering lifecycle scripts
//    (this script runs from prepublishOnly, so npm pack must not recurse).
const dest = mkdtempSync(join(tmpdir(), "dragapp-tarball-"));
try {
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", dest], {
    stdio: ["ignore", "ignore", "inherit"],
  });
} catch (err) {
  fail(`npm pack failed: ${err.message}`);
}

const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
if (!tgz) fail("no .tgz produced by npm pack");

// 2. Extract it → <dest>/package/...
execFileSync("tar", ["-xzf", join(dest, tgz), "-C", dest]);
const root = join(dest, "package");

// 3. Scan every shipped file (dist/, package.json, *.map, README, ...).
const files = walk(root);
const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable/binary — skip
  }
  const lower = text.toLowerCase();
  if (!NEEDLES.some((n) => lower.includes(n))) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const ll = line.toLowerCase();
    for (let t = 0; t < NEEDLES.length; t++) {
      if (ll.includes(NEEDLES[t])) {
        findings.push({
          file: file.slice(root.length + 1),
          line: i + 1,
          term: FORBIDDEN[t],
        });
      }
    }
  });
}

// 4. Report.
console.error(
  `tarball guard: packed ${tgz}, scanned ${files.length} shipped files for ${FORBIDDEN.length} forbidden terms`,
);
if (findings.length > 0) {
  console.error(`\nFound ${findings.length} forbidden-term occurrence(s) in the SHIPPED package:`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  →  ${f.term}`);
  }
  fail("internal names present in the package that would be published to npm");
}
console.error("✓ tarball guard passed — no internal names in the shipped package");
