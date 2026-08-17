import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const composerSource = await readFile(new URL("../web/src/components/InlineMediaComposer.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("editing a comment grows the textarea to fit its content", () => {
  assert.match(detailSource, /<InlineMediaComposer[\s\S]*?className="comment-inline-media"/);
  assert.match(composerSource, /function resizeTextarea\(element: HTMLTextAreaElement \| null\)/);
  assert.match(composerSource, /rows=\{1\}/);
  assert.match(
    composerSource,
    /onChange=\{\(event\) => \{\s*changeText\(segment\.id, event\.target\.value\);\s*resizeTextarea\(event\.currentTarget\);/,
  );
});

test("the comment edit textarea keeps the typography of a posted comment", () => {
  const posted = styles.match(/\.comment-body\s*\{([^}]*)\}/)?.[1] ?? "";
  const editing = styles.match(/\n\.comment-edit-form \.inline-media-composer textarea\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.notEqual(posted, "");
  assert.notEqual(editing, "");
  const fontSize = posted.match(/font-size:\s*([^;]+);/)?.[1];
  const lineHeight = posted.match(/line-height:\s*([^;]+);/)?.[1];
  assert.equal(fontSize, "15px");
  assert.equal(lineHeight, "24px");
  assert.match(editing, new RegExp(`font-size:\\s*${fontSize};`));
  assert.match(editing, new RegExp(`line-height:\\s*${lineHeight};`));
  assert.match(editing, /overflow:\s*hidden;/);
  assert.match(styles, /\.inline-media-composer textarea\s*\{[^}]*resize:\s*none;/s);
});
