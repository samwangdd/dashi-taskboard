import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the stream-json fixture covers every event shape the runner handles", async () => {
  const raw = await readFile(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");
  const events = raw.trim().split("\n").map((line) => JSON.parse(line));

  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  assert.ok(init, "fixture must contain a system/init event");
  assert.match(init.session_id, /^[0-9a-f-]{36}$/);
  assert.ok(Array.isArray(init.skills));
  assert.ok(Array.isArray(init.mcp_servers));

  const toolNames = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message.content)
    .filter((block) => block.type === "tool_use")
    .map((block) => block.name);
  for (const expected of ["Bash", "Edit", "WebSearch", "TodoWrite"]) {
    assert.ok(toolNames.includes(expected), `fixture must exercise ${expected}`);
  }
  assert.ok(toolNames.some((name) => name.startsWith("mcp__")), "fixture must exercise an MCP tool");

  const toolResult = events.find((event) => event.type === "user");
  assert.equal(toolResult.message.content[0].type, "tool_result");
  assert.equal(typeof toolResult.tool_use_result.stdout, "string");

  const result = events.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.subtype, "success");
  assert.equal(result.session_id, init.session_id);
});
