import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const chatSource = await readFile(
  new URL("../web/src/components/AiChat.tsx", import.meta.url),
  "utf8",
);
const detailSource = await readFile(
  new URL("../web/src/components/TaskDetail.tsx", import.meta.url),
  "utf8",
);
const editorSource = await readFile(
  new URL("../web/src/components/TaskEditor.tsx", import.meta.url),
  "utf8",
);

test("all four issue composers request candidates with the owning project and surface", () => {
  assert.match(
    editorSource,
    /completionContext=\{projectId \? \{ projectId, surface: "issue-description" \} : undefined\}/,
  );
  assert.equal(
    detailSource.match(/surface: "issue-description"/g)?.length,
    1,
  );
  assert.equal(detailSource.match(/surface: "comment"/g)?.length, 2);
  assert.match(appSource, /projectId=\{editorProjectId\}/);
});

test("open in new conversation launches the Codex desktop composer from the standalone browser", () => {
  assert.match(apiSource, /"\/api\/local\/ai\/composer\/rebind"/);
  assert.doesNotMatch(appSource, /rebindAiChatComposerReferences/);
  assert.doesNotMatch(
    appSource,
    /if \(localAiChatAvailable\) \{\s*if \(isAllProjects\) openTaskDetail\(task\);[\s\S]*?setAiOpenThreadRequest/,
  );
  assert.match(appSource, /new URL\("codex:\/\/threads\/new"\)/);
  assert.match(appSource, /deepLink\.searchParams\.set\("path", workspacePath\)/);
  assert.match(appSource, /deepLink\.searchParams\.set\("prompt", embeddedInstruction\)/);
  assert.match(appSource, /type: "taskboard:create-thread"/);
  assert.match(chatSource, /await rebindAiChatComposerReferences\(\{/);
  assert.match(chatSource, /node\.type === "skill" \|\| node\.type === "agent"/);
});
