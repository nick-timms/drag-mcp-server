#!/usr/bin/env node
/**
 * prepublishOnly guard for @dragapp/mcp-server (PUBLIC package).
 *
 * Packs the tarball exactly as it would ship to npm, extracts it, and greps
 * EVERY packaged file (compiled dist/, package.json, and *.map source maps —
 * which embed the original TypeScript source incl. comments) for a list of
 * sensitive terms that must never ship. Aborts `npm publish` if any are found.
 *
 * The term list is intentionally NOT stored in this public repo. It is read
 * from either:
 *   (a) the FORBIDDEN_TERMS env var (comma-separated), or
 *   (b) an untracked local file `.forbidden-terms` (one term per line; blank
 *       lines and lines starting with `#` are ignored).
 *
 * If neither is present, the guard prints a warning and PASSES, so external
 * contributors can still build and publish forks without the private list.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function loadForbiddenTerms() {
  const env = process.env.FORBIDDEN_TERMS;
  if (env && env.trim()) {
    return { source: "FORBIDDEN_TERMS env var", terms: env.split(",").map((s) => s.trim()).filter(Boolean) };
  }
  const file = join(process.cwd(), ".forbidden-terms");
  if (existsSync(file)) {
    const terms = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("#"));
    return { source: ".forbidden-terms", terms };
  }
  return null;
}

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

const loaded = loadForbiddenTerms();
if (!loaded || loaded.terms.length === 0) {
  console.error(
    "⚠ tarball guard: no term list found — set FORBIDDEN_TERMS or create a local .forbidden-terms file. Skipping sensitive-term scan (build not blocked).",
  );
  process.exit(0);
}
const FORBIDDEN = loaded.terms;
const NEEDLES = FORBIDDEN.map((t) => t.toLowerCase());

// 1. Pack the tarball. --ignore-scripts avoids re-triggering lifecycle scripts
//    (this runs from prepublishOnly, so npm pack must not recurse).
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
        findings.push({ file: file.slice(root.length + 1), line: i + 1, term: FORBIDDEN[t] });
      }
    }
  });
}

// 4. Report.
console.error(
  `tarball guard: packed ${tgz}, scanned ${files.length} shipped files against ${FORBIDDEN.length} term(s) from ${loaded.source}`,
);
if (findings.length > 0) {
  console.error(`\nFound ${findings.length} forbidden-term occurrence(s) in the SHIPPED package:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  →  ${f.term}`);
  fail("sensitive term(s) present in the package that would be published to npm");
}
console.error("✓ tarball guard passed — no forbidden terms in the shipped package");
