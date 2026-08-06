import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { normalizeClaudeEvent } from "../server/ai-chat-process.mjs";

async function fixtureEvents() {
  const raw = await readFile(new URL("./fixtures/claude-stream.jsonl", import.meta.url), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

test("system/init yields the session id and nothing visible", async () => {
  const [init] = await fixtureEvents();
  assert.deepEqual(normalizeClaudeEvent(init), {
    kind: "session",
    sessionId: "6f1c2d34-5678-4abc-9def-0123456789ab",
  });
});

test("assistant text becomes an agent_message", async () => {
  const events = await fixtureEvents();
  const text = events.find((event) => event.type === "assistant"
    && event.message.content[0].type === "text");
  const normalized = normalizeClaudeEvent(text);
  assert.equal(normalized.type, "agent_message");
  assert.equal(normalized.role, "assistant");
  assert.equal(normalized.content, "DONE");
});

test("thinking blocks are dropped", async () => {
  const events = await fixtureEvents();
  const thinking = events.find((event) => event.type === "assistant"
    && event.message.content[0].type === "thinking");
  assert.equal(normalizeClaudeEvent(thinking), null);
});

test("tool_use maps to an item type by tool name", async () => {
  const events = await fixtureEvents();
  const byTool = new Map();
  for (const event of events) {
    if (event.type !== "assistant") continue;
    for (const block of event.message.content) {
      if (block.type === "tool_use") byTool.set(block.name, normalizeClaudeEvent(event));
    }
  }
  assert.equal(byTool.get("Bash").type, "command_execution");
  assert.equal(byTool.get("Bash").data.command, "echo hello-fixture");
  assert.equal(byTool.get("Edit").type, "file_change");
  assert.equal(byTool.get("Edit").data.path, "/repo/src/a.ts");
  assert.equal(byTool.get("WebSearch").type, "web_search");
  assert.equal(byTool.get("TodoWrite").type, "todo_list");
  assert.equal(byTool.get("mcp__context7__query-docs").type, "mcp_tool_call");
});

test("an unmapped tool falls back to command_execution and records its name", () => {
  const normalized = normalizeClaudeEvent({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_Z", name: "Grep", input: { pattern: "x" } }] },
  });
  assert.equal(normalized.type, "command_execution");
  assert.equal(normalized.data.tool, "Grep");
});

test("a tool_result closes the item and carries its status", async () => {
  const events = await fixtureEvents();
  const normalized = normalizeClaudeEvent(events.find((event) => event.type === "user"));
  assert.equal(normalized.type, "command_execution");
  assert.equal(normalized.data.status, "completed");
  assert.equal(normalized.data.itemId, "toolu_A");
});

test("a failed tool_result is reported as failed", () => {
  const normalized = normalizeClaudeEvent({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "boom", is_error: true }] },
    tool_use_result: { stdout: "", stderr: "boom", interrupted: false },
  });
  assert.equal(normalized.data.status, "failed");
  assert.equal(normalized.data.stderr, "boom");
});

test("noise events are ignored", () => {
  for (const raw of [
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 5 },
    { type: "system", subtype: "status", status: "ok" },
    { type: "system", subtype: "hook_started", hook_name: "x" },
    { type: "system", subtype: "hook_response", hook_name: "x", exit_code: 0 },
    { type: "stream_event", event: { type: "content_block_delta" } },
    { type: "rate_limit_event", rate_limit_info: {} },
    null,
    "not an object",
  ]) {
    assert.equal(normalizeClaudeEvent(raw), null);
  }
});

test("result carries completion and the final text", async () => {
  const events = await fixtureEvents();
  const normalized = normalizeClaudeEvent(events.at(-1));
  assert.equal(normalized.kind, "completed");
  assert.equal(normalized.result.text, "DONE");
  assert.equal(normalized.result.isError, false);
  assert.equal(normalized.result.sessionId, "6f1c2d34-5678-4abc-9def-0123456789ab");
  assert.equal(normalized.result.numTurns, 3);
});

test("an error result is reported as an error", () => {
  const normalized = normalizeClaudeEvent({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "boom",
    session_id: "6f1c2d34-5678-4abc-9def-0123456789ab",
  });
  assert.equal(normalized.kind, "completed");
  assert.equal(normalized.result.isError, true);
});
