import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const bundle = await readFile(new URL("../dist/sandbox.mjs", import.meta.url), "utf8");
assert.equal(/from\s+["']\.\//.test(bundle), false, "sandbox bundle must not contain relative imports");
assert.equal(/import\s*\(["']\.\//.test(bundle), false, "sandbox bundle must not dynamically import relative files");
assert.match(bundle, /v1\/segments\/members\/add/);
assert.match(bundle, /v1\/statistics\/summary/);
assert.match(bundle, /v1\/config\/file\/load/);
assert.match(bundle, /crm-growth-score-v2-file-config/);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

const sourceRoot = new URL("../src/", import.meta.url);
const sourceEntries = await readdir(sourceRoot, { recursive: true, withFileTypes: true });
for (const entry of sourceEntries) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const relativeParent = entry.parentPath.replace(new URL(sourceRoot).pathname, "").replace(/^\//, "");
  const fileUrl = new URL(join(relativeParent, entry.name), sourceRoot);
  const source = stripComments(await readFile(fileUrl, "utf8"));
  assert.equal(/=>/.test(source), false, entry.name + " must not use arrow functions");
  assert.equal(/\b(?:const|let)\b/.test(source), false, entry.name + " must use var in sandbox runtime code");
  assert.equal(/`/.test(source), false, entry.name + " must not use template literals");
  assert.equal(/\.\.\.\s*[A-Za-z_$]/.test(source), false, entry.name + " must not use object/array spread");
  assert.equal(/\.flatMap\s*\(/.test(source), false, entry.name + " must not call flatMap");
}

console.log("CRM Studio sandbox bundle and ES5 source checks passed");
