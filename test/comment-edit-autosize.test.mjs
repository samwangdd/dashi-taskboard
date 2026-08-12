import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

const editTextarea = detailSource.match(/<textarea\s+className="comment-input"[\s\S]*?\/>/)?.[0] ?? "";

test("editing a comment grows the textarea to fit its content", () => {
  assert.notEqual(editTextarea, "");
  assert.match(editTextarea, /ref=\{resizeTextarea\}/);
  assert.match(editTextarea, /rows=\{1\}/);
  assert.match(
    editTextarea,
    /onChange=\{\(event\) => \{\s*setEditingBody\(event\.target\.value\);\s*resizeTextarea\(event\.currentTarget\);\s*\}\}/,
  );
});

test("the comment edit textarea keeps the typography of a posted comment", () => {
  const posted = styles.match(/\.comment-body\s*\{([^}]*)\}/)?.[1] ?? "";
  const editing = styles.match(/\n\.comment-edit-form textarea\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.notEqual(posted, "");
  assert.notEqual(editing, "");
  const fontSize = posted.match(/font-size:\s*([^;]+);/)?.[1];
  const lineHeight = posted.match(/line-height:\s*([^;]+);/)?.[1];
  assert.equal(fontSize, "15px");
  assert.equal(lineHeight, "24px");
  assert.match(editing, new RegExp(`font-size:\\s*${fontSize};`));
  assert.match(editing, new RegExp(`line-height:\\s*${lineHeight};`));
  assert.match(editing, /resize:\s*none;/);
  assert.match(editing, /overflow:\s*hidden;/);
});
