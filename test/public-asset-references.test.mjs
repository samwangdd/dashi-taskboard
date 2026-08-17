import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "node:test";

const srcUrl = new URL("../web/src/", import.meta.url);
const publicUrl = new URL("../web/public/", import.meta.url);

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) {
      if (entry.name === "assets") continue;
      files.push(...(await collectSourceFiles(child)));
    } else if (/\.(tsx?|css)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

async function exists(url) {
  try {
    await stat(url);
    return true;
  } catch {
    return false;
  }
}

const sourceFiles = await collectSourceFiles(srcUrl);

// Literal `src="..."` values that are neither bundled imports (`${...}`/`{...}`)
// nor remote/inline URLs must resolve to a real file under web/public.
const literalSrcPattern = /\bsrc=(?:"([^"{}$]*)"|\{"([^"{}$]*)"\})/g;

test("literal img src values point at existing public assets", async () => {
  const problems = [];
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(literalSrcPattern)) {
      const value = match[1] ?? match[2];
      if (!value || /^(https?:|data:|blob:|about:|#)/.test(value)) continue;
      if (!value.startsWith("/")) {
        problems.push(
          `${file.pathname}: src="${value}" is relative, so it breaks on nested routes; use a root-absolute path`,
        );
        continue;
      }
      if (!(await exists(new URL(value.slice(1), publicUrl)))) {
        problems.push(`${file.pathname}: src="${value}" has no matching file in web/public`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
