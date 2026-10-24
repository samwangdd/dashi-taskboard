import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/manage-taskboard/SKILL.md", import.meta.url),
  "utf8",
);
const cliReference = await readFile(
  new URL("../skills/manage-taskboard/references/cli.md", import.meta.url),
  "utf8",
);

test("the taskboard skill disambiguates companion terminology for agents", () => {
  assert.match(skillSource, /## Terminology: local companion/i);
  assert.match(skillSource, /device-local loopback service/i);
  assert.match(skillSource, /Never translate as \*\*伴侣\*\*/i);
  assert.match(skillSource, /not “companion API”/i);

  assert.match(cliReference, /## Terminology: local companion/i);
  assert.match(cliReference, /Do not use/i);
  assert.match(cliReference, /伴侣 API/i);
  assert.match(cliReference, /Taskboard HTTP API/i);
  assert.match(cliReference, /local loopback service/i);
});

test("the taskboard skill coordinates authority-backed execution and handoff", () => {
  assert.match(skillSource, /first run `issue get` and `comment list`/);
  assert.match(skillSource, /Historical `threadBinding` \/ `agentSession` alone never locks a `todo`/);
  assert.match(skillSource, /another active claim or legacy unverified execution remains protected/);
  assert.match(skillSource, /release the active claim to `in_review`/);
  assert.match(skillSource, /Codex execution owners require all five real fields/);
  assert.match(skillSource, /Preserve the exact active claim owner and claim ID/);
  assert.match(cliReference, /--binding-thread-id ID/);
  assert.match(cliReference, /execution protocol 1/);
});
